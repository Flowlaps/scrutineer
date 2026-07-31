import { dedupeByFinding, type ReviewResult } from "./ai-orchestrator.js";
import type { PrReviewComment } from "./github-client.js";
import { parseDiffHunks, resolveInlineLocation } from "./diff-hunks.js";
import { groupFindingsBySeverity, neutralizeBlockStarts, singleLine, type ReviewFinding } from "./review-schema.js";
import { buildSandboxSection, buildTruncationNotice } from "./report.js";

export interface InlineReviewContent {
  body: string;
  comments: PrReviewComment[];
}

interface UnanchoredFinding {
  personaLabel: string;
  file: string;
  finding: ReviewFinding;
}

interface LabeledFinding {
  personaLabel: string;
  finding: ReviewFinding;
}

// Persona findings carry no label of their own (see reviewFindingSchema) —
// both `${label}` prefixes below exist so a reader looking at an inline
// comment, or the unanchored-findings list, can tell which persona raised it
// without cross-referencing back to a section heading.
const PERSONA_LABELS = {
  codeReview: "Code Review",
  securityAudit: "Security Audit",
} as const;

// `file` is untrusted, LLM-echoed diff content just like severity/title (see
// review-schema.ts's findingLocation()) — singleLine() it before
// interpolating, or an embedded blank line forges a heading straight into the
// cover note's "Additional Findings" bullet (PR #51 review).
function findingHeading(personaLabel: string, finding: ReviewFinding, file?: string): string {
  const prefix = file ? `[${singleLine(file)}] ` : "";
  const titlePart = finding.title ? `: ${singleLine(finding.title)}` : "";
  return `${prefix}**${personaLabel} — ${singleLine(finding.severity)}${titlePart}**`;
}

// The body of a single GitHub inline review comment. No location prefix —
// the comment's own path/line already anchors it — just persona, severity,
// title, and the (heading-injection-neutralized) description.
//
// Passes guardFirstLine: true to neutralizeBlockStarts, unlike
// review-schema.ts's renderFinding(): here the description sits on its own
// line after a blank line (not fused onto the heading's source line), so a
// leading block-start marker in the description's first line is just as
// exploitable as one in any later line (PR #51 review — confirmed against a
// real GitHub-rendered comment).
function findingCommentBody(personaLabel: string, finding: ReviewFinding): string {
  return `${findingHeading(personaLabel, finding)}\n\n${neutralizeBlockStarts(finding.description, true)}`;
}

function findingsSummaryLine(label: string, findings: ReviewFinding[]): string {
  if (findings.length === 0) {
    return `- **${label}:** no findings`;
  }
  const counts = groupFindingsBySeverity(findings)
    .map(({ display, findings: group }) => `${group.length} ${display}`)
    .join(", ");
  return `- **${label}:** ${findings.length} finding(s) (${counts})`;
}

function buildCoverNote(result: ReviewResult, commentCount: number, unanchored: UnanchoredFinding[]): string {
  const lines: string[] = ["# Scrutineer Review", "", ...buildTruncationNotice(result.truncations)];

  if (result.codeReview.review.verdict) {
    lines.push(`**Verdict:** ${singleLine(result.codeReview.review.verdict)}`, "");
  }

  lines.push(
    "## Summary",
    "",
    findingsSummaryLine(PERSONA_LABELS.codeReview, result.codeReview.review.findings),
    findingsSummaryLine(PERSONA_LABELS.securityAudit, result.securityAudit.review.findings),
    unanchored.length > 0
      ? `- ${commentCount} finding(s) posted as inline comments below; ${unanchored.length} finding(s) couldn't be anchored to a changed line and are listed here instead`
      : `- ${commentCount} finding(s) posted as inline comments below`,
    "",
  );

  if (unanchored.length > 0) {
    lines.push("### Additional Findings (not anchored to a changed line)", "");
    for (const { personaLabel, file, finding } of unanchored) {
      lines.push(`- ${findingHeading(personaLabel, finding, file)} ${neutralizeBlockStarts(finding.description)}`);
    }
    lines.push("");
  }

  lines.push(...buildSandboxSection(result.sandboxTest));

  return lines.join("\n");
}

/**
 * Turns a `ReviewResult` + the diff it was reviewed against into the shape
 * `postPrReview()` needs (issue #46 step 4): one inline `PrReviewComment` per
 * finding whose `line` validates against the diff's hunks (see diff-hunks.ts),
 * plus a short cover-note `body` carrying everything that doesn't anchor to a
 * single line — the verdict, severity/summary counts, any finding that
 * couldn't be line-anchored, and the Sandbox Test section.
 */
export function buildInlineReview(result: ReviewResult, diff: string): InlineReviewContent {
  const hunkLines = parseDiffHunks(diff);
  const comments: PrReviewComment[] = [];
  const unanchored: UnanchoredFinding[] = [];

  // Security-auditor's findings go first: when both personas flag the same
  // file+line with substantially similar wording (issue #61), dedupeByFinding
  // keeps the first occurrence per bucket, so this ordering keeps the
  // security classification over the code-reviewer's on overlap.
  const labeled: LabeledFinding[] = [
    ...result.securityAudit.review.findings.map((finding) => ({ personaLabel: PERSONA_LABELS.securityAudit, finding })),
    ...result.codeReview.review.findings.map((finding) => ({ personaLabel: PERSONA_LABELS.codeReview, finding })),
  ];

  for (const { personaLabel, finding } of dedupeByFinding(labeled, (item) => item.finding)) {
    const location = resolveInlineLocation(finding, hunkLines);
    if (location.line !== undefined) {
      comments.push({ path: location.file, line: location.line, body: findingCommentBody(personaLabel, finding) });
    } else {
      unanchored.push({ personaLabel, file: location.file, finding });
    }
  }

  return { body: buildCoverNote(result, comments.length, unanchored), comments };
}
