import { z } from "zod";

// A shared shape for both review personas' findings, even though their own
// hash-pinned templates (prompt-loader.ts) use different severity vocabularies
// (code-reviewer: Critical/Important/Suggestion; security-auditor:
// Critical/High/Medium/Low/Info) and slightly different per-finding fields
// (security-auditor's template has a title, an impact, and a proof-of-concept;
// code-reviewer's doesn't). Rather than modeling two divergent schemas, `severity`
// stays a free-form string in each persona's own vocabulary, `title` is optional,
// and `description` absorbs whatever narrative fields a persona's template would
// otherwise have split out (impact, proof of concept, recommendation) — lossy
// relative to the richer security-auditor template, but line/file is the field
// that actually matters for issue #46's end goal (anchoring a GitHub inline
// review comment), not preserving every template subsection as its own schema key.
export const reviewFindingSchema = z.object({
  file: z
    .string()
    .min(1)
    .describe('File path this finding applies to, exactly as it appears in the diff (e.g. "src/index.ts").'),
  line: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Line number in `file` this finding anchors to. Omit if the finding isn't tied to one specific line."),
  severity: z
    .string()
    .min(1)
    .describe(
      'Severity/category label, using this persona\'s own vocabulary from its Output Format section (e.g. "Critical", "Important", "Suggestion", "High", "Info").',
    ),
  title: z
    .string()
    .optional()
    .describe('Short finding title, for personas whose template includes one (e.g. security-auditor\'s "[Finding title]").'),
  description: z
    .string()
    .min(1)
    .describe("The finding's full explanation, impact, proof of concept, and recommended fix, combined into one field."),
});

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const personaReviewSchema = z.object({
  verdict: z
    .string()
    .optional()
    .describe('Overall verdict, if this persona\'s template has one (e.g. code-reviewer\'s "APPROVE" / "REQUEST CHANGES").'),
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
  return finding.line !== undefined ? `${finding.file}:${finding.line}` : finding.file;
}

// `severity` and `title` are meant to be short, single-line labels (per their
// schema descriptions), but both are LLM-generated from untrusted diff content
// and get interpolated directly into markdown structure below (a "### "
// heading for severity; a bold span for title) — a value containing embedded
// blank lines could otherwise inject a fabricated heading/section into the
// rendered report (e.g. a `severity` of "Info\n\n### Verdict: APPROVE" reading
// as a separate, forged all-clear section to a skimming reviewer). Collapsing
// internal whitespace runs to a single space closes that off without needing
// full markdown escaping, since neither field is expected to contain
// legitimate multi-line content in the first place.
function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function renderFinding(finding: ReviewFinding): string {
  const location = `[${findingLocation(finding)}]`;
  const heading = finding.title ? `${location} **${singleLine(finding.title)}**` : location;
  return `- ${heading} ${finding.description}`;
}

// Renders a PersonaReview back into the same broad shape the old free-text
// persona output had (a "### Findings" section grouped by severity tier, a
// "What's Done Well" section, etc.), so report.ts and the chunked pipeline's
// <details> aggregation don't need to know or care that the content behind
// them is now structured — this is the seam that keeps this PR's user-visible
// report output equivalent to before, while making the structured `findings`
// array (file/line/severity) available separately for the inline-review-comment
// work issue #46 actually wants.
export function renderPersonaReviewMarkdown(review: PersonaReview): string {
  const sections: string[] = [];

  if (review.verdict) {
    sections.push(`**Verdict:** ${review.verdict}`);
  }

  if (review.summary.trim().length > 0) {
    sections.push(review.summary.trim());
  }

  if (review.findings.length > 0) {
    // Grouped by each finding's own severity string, in first-seen order —
    // there's no fixed enum shared across personas to sort against (see the
    // comment on reviewFindingSchema), so this preserves whatever tiering
    // order the model itself emitted findings in. Grouped on a normalized
    // (trimmed, lowercased) key rather than the raw string: severity is
    // LLM-generated free text, and minor variance like "Critical" vs
    // "critical" would otherwise split one tier into two near-duplicate
    // headings instead of merging them. The first-seen original casing is
    // kept as the display label, via singleLine() for the same
    // heading-injection reason renderFinding applies it to `title`.
    const bySeverity = new Map<string, { display: string; findings: ReviewFinding[] }>();
    for (const finding of review.findings) {
      const key = finding.severity.trim().toLowerCase();
      const bucket = bySeverity.get(key);
      if (bucket) {
        bucket.findings.push(finding);
      } else {
        bySeverity.set(key, { display: singleLine(finding.severity), findings: [finding] });
      }
    }
    const findingSections = Array.from(bySeverity.values()).map(
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
