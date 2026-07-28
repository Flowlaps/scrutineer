import { z } from "zod";

// A shared shape for both review personas' findings, even though their own
// hash-pinned templates (prompt-loader.ts) use different severity vocabularies
// (code-reviewer: Critical/Important/Suggestion; security-auditor:
// Critical/High/Medium/Low/Info) and slightly different per-finding fields
// (security-auditor's template has a title, an impact, and a proof-of-concept;
// code-reviewer's doesn't). Rather than modeling two divergent schemas, `severity`
// stays a free-form string in each persona's own vocabulary, `title` is nullable,
// and `description` absorbs whatever narrative fields a persona's template would
// otherwise have split out (impact, proof of concept, recommendation) — lossy
// relative to the richer security-auditor template, but line/file is the field
// that actually matters for issue #46's end goal (anchoring a GitHub inline
// review comment), not preserving every template subsection as its own schema key.
//
// `line`, `title`, and `verdict` below are `.nullable()` rather than `.optional()`:
// OpenAI's structured-outputs strict mode requires every property to appear in
// the object's `required` array, which the Vercel AI SDK's schema conversion
// only does for non-optional properties — an `.optional()` field gets dropped
// from `required` and OpenAI rejects the whole schema (issue #57). Anthropic and
// Gemini tolerate plain-optional fields, so this only ever surfaced there.
// `.nullable()` keeps the key required while still modeling "no value" as `null`.
export const reviewFindingSchema = z.object({
  file: z
    .string()
    .min(1)
    .describe('File path this finding applies to, exactly as it appears in the diff (e.g. "src/index.ts").'),
  line: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe("Line number in `file` this finding anchors to. `null` if the finding isn't tied to one specific line."),
  severity: z
    .string()
    .min(1)
    .describe(
      'Severity/category label, using this persona\'s own vocabulary from its Output Format section (e.g. "Critical", "Important", "Suggestion", "High", "Info").',
    ),
  title: z
    .string()
    .nullable()
    .describe('Short finding title, for personas whose template includes one (e.g. security-auditor\'s "[Finding title]"). `null` if none.'),
  description: z
    .string()
    .min(1)
    .describe("The finding's full explanation, impact, proof of concept, and recommended fix, combined into one field."),
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const personaReviewSchema = z.object({
  verdict: z
    .string()
    .nullable()
    .describe('Overall verdict, if this persona\'s template has one (e.g. code-reviewer\'s "APPROVE" / "REQUEST CHANGES"). `null` if none.'),
  summary: z
    .string()
    .describe(
      "The template's overview/summary prose that isn't tied to one finding — not a restatement of the findings themselves.",
    ),
  findings: z.array(reviewFindingSchema).describe("Every finding from every severity tier, in the order the template would list them."),
  positiveObservations: z
    .array(z.string())
    .describe('Things done well / positive practices observed — the template\'s "What\'s Done Well" / "Positive Observations" section.'),
  additionalNotes: z
    .array(z.string())
    .describe(
      'Any other template content not captured above (e.g. code-reviewer\'s "Verification Story", security-auditor\'s general "Recommendations") — empty if none.',
    ),
});

export type PersonaReview = z.infer<typeof personaReviewSchema>;

function findingLocation(finding: ReviewFinding): string {
  const file = singleLine(finding.file);
  return finding.line != null ? `${file}:${finding.line}` : file;
}

// `severity`, `title`, and `file` are meant to be short, single-line labels
// (per their schema descriptions), but all are LLM-generated from untrusted
// diff content and get interpolated directly into markdown structure below (a
// "### " heading for severity; a bold span for title; a bracketed location for
// file) — a value containing embedded blank lines could otherwise inject a
// fabricated heading/section into the rendered report (e.g. a `severity` of
// "Info\n\n### Verdict: APPROVE" reading as a separate, forged all-clear
// section to a skimming reviewer). Collapsing internal whitespace runs to a
// single space closes that off without needing full markdown escaping, since
// none of the three is expected to contain legitimate multi-line content in
// the first place — unlike `description` below, which legitimately can.
// Exported so inline-review.ts (issue #46 step 4) can apply the same
// heading-injection guard to finding text rendered into a GitHub inline
// review comment, instead of re-deriving this collapsing logic separately.
export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// Splices a zero-width space (see ZERO_WIDTH_SPACE in ai-orchestrator.ts's
// neutralizeStructuralTags for the same technique) in front of any line — other
// than the first, which is fused onto the bullet's own source line via
// renderFinding and can't start a fresh block on its own — that GFM/CommonMark
// would otherwise parse as starting a new block: an ATX heading, blockquote,
// thematic break, list item, or fenced code block. Unlike `singleLine()`,
// `description` legitimately can and does span multiple paragraphs, so this
// targets only the specific constructs that would break a line out of the
// current bullet's list item and render at full, un-nested visibility (PR #48
// review: `description` is the single largest, most diff-influenced field in
// the schema, and the same forged-heading risk closed for `severity`/`title`
// applies to it too — CommonMark's "lazy continuation" doesn't protect against
// these constructs even without a full blank line separating them). The
// invisible character breaks pattern recognition without changing what a human
// reader sees.
//
// The dash/equals alternatives below (`(?:-[ \t]*){1,}$` / `(?:=[ \t]*){1,}$`)
// intentionally have no minimum repeat count, unlike the underscore/asterisk
// thematic-break alternatives (which need 3+): a CommonMark setext heading
// underline is a bare `-` or `=` — no minimum length, no trailing content
// required — and promotes the *preceding* line into a real heading regardless.
// An earlier version of this pattern required `{3,}` uniformly and missed
// exactly this (verified against a real CommonMark renderer during PR #48's
// review — a lone `-` or `=` line reproduced the same forged-heading result as
// the ATX-heading case this function already handled). The `[ \t]*` inside the
// repetition (rather than a trailing `\s*`) also catches the space-separated
// thematic-break form (`- - -`), not just contiguous runs (`---`).
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const BLOCK_START_PATTERN =
  /^(\s{0,3})(#{1,6}\s|>|(?:-[ \t]*){1,}$|(?:=[ \t]*){1,}$|(?:_[ \t]*){3,}$|(?:\*[ \t]*){3,}$|[-*+]\s|\d+[.)]\s|```|~~~)/;
// Exported alongside singleLine() for the same reason — inline-review.ts
// renders finding descriptions into standalone GitHub comment bodies and
// needs the identical multi-line block-injection guard this module already
// applies to the aggregated markdown report.
//
// `guardFirstLine` defaults to false because renderFinding() below (this
// function's original caller) fuses line 0 onto the same source line as the
// bullet marker/heading (`- [loc] **title** ${neutralizeBlockStarts(desc)}`),
// so a block-start marker there can't actually break out onto its own line —
// it stays mid-sentence in the same list item. A caller that instead puts
// `text` on its own line (e.g. after a blank-line-separated heading, the way
// inline-review.ts's findingCommentBody() does) does NOT get that same
// protection for free and must pass `guardFirstLine: true`, or a leading
// `#`/`>`/list-marker/fence in line 0 renders as a real block start (PR #51
// review — confirmed against a real GitHub-rendered comment).
export function neutralizeBlockStarts(text: string, guardFirstLine = false): string {
  return text
    .split("\n")
    .map((line, i) =>
      i === 0 && !guardFirstLine
        ? line
        : line.replace(BLOCK_START_PATTERN, (_match, indent: string, marker: string) => `${indent}${ZERO_WIDTH_SPACE}${marker}`),
    )
    .join("\n");
}

function renderFinding(finding: ReviewFinding): string {
  const location = `[${findingLocation(finding)}]`;
  const heading = finding.title ? `${location} **${singleLine(finding.title)}**` : location;
  return `- ${heading} ${neutralizeBlockStarts(finding.description)}`;
}

// Renders a PersonaReview back into the same broad shape the old free-text
// persona output had (a "### Findings" section grouped by severity tier, a
// "What's Done Well" section, etc.), so report.ts and the chunked pipeline's
// <details> aggregation don't need to know or care that the content behind
// them is now structured — this is the seam that keeps this PR's user-visible
// report output equivalent to before, while making the structured `findings`
// array (file/line/severity) available separately for the inline-review-comment
// work issue #46 actually wants.
export interface SeverityGroup {
  display: string;
  findings: ReviewFinding[];
}

// Grouped by each finding's own severity string, in first-seen order —
// there's no fixed enum shared across personas to sort against (see the
// comment on reviewFindingSchema), so this preserves whatever tiering order
// the model itself emitted findings in. Grouped on a normalized (trimmed,
// lowercased) key rather than the raw string: severity is LLM-generated free
// text, and minor variance like "Critical" vs "critical" would otherwise
// split one tier into two near-duplicate groups instead of merging them. The
// first-seen original casing is kept as the display label, via singleLine()
// for the same heading-injection reason renderFinding applies it to `title`.
// Exported so inline-review.ts's cover-note severity counts (issue #46 step
// 4) group and display findings identically to the aggregated markdown
// report below, instead of a second grouping implementation that could drift.
export function groupFindingsBySeverity(findings: ReviewFinding[]): SeverityGroup[] {
  const bySeverity = new Map<string, SeverityGroup>();
  for (const finding of findings) {
    const key = finding.severity.trim().toLowerCase();
    const bucket = bySeverity.get(key);
    if (bucket) {
      bucket.findings.push(finding);
    } else {
      bySeverity.set(key, { display: singleLine(finding.severity), findings: [finding] });
    }
  }
  return Array.from(bySeverity.values());
}

export function renderPersonaReviewMarkdown(review: PersonaReview): string {
  const sections: string[] = [];

  if (review.verdict) {
    sections.push(`**Verdict:** ${review.verdict}`);
  }

  if (review.summary.trim().length > 0) {
    sections.push(review.summary.trim());
  }

  if (review.findings.length > 0) {
    const findingSections = groupFindingsBySeverity(review.findings).map(
      ({ display, findings }) => `### ${display}\n\n${findings.map(renderFinding).join("\n")}`,
    );
    sections.push(findingSections.join("\n\n"));
  }

  if (review.positiveObservations.length > 0) {
    sections.push(`### What's Done Well\n\n${review.positiveObservations.map((line) => `- ${line}`).join("\n")}`);
  }

  if (review.additionalNotes.length > 0) {
    sections.push(`### Notes\n\n${review.additionalNotes.map((line) => `- ${line}`).join("\n")}`);
  }

  return sections.join("\n\n");
}
