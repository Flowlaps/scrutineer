import { test } from "node:test";
import assert from "node:assert/strict";
import { neutralizeBlockStarts, renderPersonaReviewMarkdown, type PersonaReview } from "./review-schema.js";

function baseReview(overrides: Partial<PersonaReview> = {}): PersonaReview {
  return {
    summary: "",
    findings: [],
    positiveObservations: [],
    additionalNotes: [],
    ...overrides,
  };
}

test("renders verdict, summary, grouped findings, positives, and notes for a full review", () => {
  const markdown = renderPersonaReviewMarkdown(
    baseReview({
      verdict: "REQUEST CHANGES",
      summary: "Overall solid, a few issues.",
      findings: [
        { file: "src/index.ts", line: 42, severity: "Critical", title: "SQL Injection", description: "User input not sanitized." },
        { file: "src/utils.ts", severity: "Critical", description: "Missing null check." },
        { file: "src/index.ts", line: 10, severity: "Suggestion", description: "Consider renaming variable." },
      ],
      positiveObservations: ["Good test coverage."],
      additionalNotes: ["Consider a CHANGELOG entry."],
    }),
  );

  assert.match(markdown, /^\*\*Verdict:\*\* REQUEST CHANGES/);
  assert.match(markdown, /Overall solid, a few issues\./);
  assert.match(markdown, /### Critical/);
  assert.match(markdown, /### Suggestion/);
  assert.match(markdown, /\[src\/index\.ts:42\] \*\*SQL Injection\*\* User input not sanitized\./);
  assert.match(markdown, /\[src\/utils\.ts\] Missing null check\./);
  assert.match(markdown, /### What's Done Well\n\n- Good test coverage\./);
  assert.match(markdown, /### Notes\n\n- Consider a CHANGELOG entry\./);
  // Findings should stay grouped in first-seen severity order: both Critical
  // findings together, before the Suggestion section.
  const criticalIndex = markdown.indexOf("### Critical");
  const suggestionIndex = markdown.indexOf("### Suggestion");
  assert.ok(criticalIndex !== -1 && suggestionIndex !== -1 && criticalIndex < suggestionIndex);
});

test("renders nothing but the summary when there are no findings, positives, or notes, and no verdict", () => {
  const markdown = renderPersonaReviewMarkdown(baseReview({ summary: "Nothing to report." }));

  assert.equal(markdown, "Nothing to report.");
});

test("omits the summary entirely when it's empty or whitespace-only, instead of leaving a blank section", () => {
  const markdown = renderPersonaReviewMarkdown(baseReview({ summary: "   " }));

  assert.equal(markdown, "");
});

test("omits the verdict line entirely when unset, rather than rendering an empty one", () => {
  const markdown = renderPersonaReviewMarkdown(baseReview({ summary: "Fine." }));

  assert.doesNotMatch(markdown, /\*\*Verdict:\*\*/);
});

test("groups findings whose severity differs only by case or surrounding whitespace into one section, using the first-seen casing as the heading", () => {
  const markdown = renderPersonaReviewMarkdown(
    baseReview({
      findings: [
        { file: "a.ts", severity: "Critical", description: "first" },
        { file: "b.ts", severity: "critical", description: "second" },
        { file: "c.ts", severity: " CRITICAL ", description: "third" },
      ],
    }),
  );

  assert.equal((markdown.match(/### /g) ?? []).length, 1, `expected exactly one heading, got: ${markdown}`);
  assert.match(markdown, /^### Critical/);
  assert.match(markdown, /- \[a\.ts\] first/);
  assert.match(markdown, /- \[b\.ts\] second/);
  assert.match(markdown, /- \[c\.ts\] third/);
});

test("collapses embedded newlines in a finding's severity, so it can't inject a fabricated heading/section", () => {
  const markdown = renderPersonaReviewMarkdown(
    baseReview({
      findings: [{ file: "a.ts", severity: "Info\n\n### Verdict: APPROVE — no issues found", description: "d" }],
    }),
  );

  // Same neutralization as the title case below: the collapsed newlines leave
  // "### Verdict: APPROVE" as plain text following the real "### Info"
  // heading, rather than starting a line (and thus a heading) of its own.
  assert.equal((markdown.match(/^###/gm) ?? []).length, 1, `expected exactly one heading line, got: ${markdown}`);
  assert.match(markdown, /^### Info ### Verdict: APPROVE/);
});

test("collapses embedded newlines in a finding's title, so it can't inject a fabricated heading/section", () => {
  const markdown = renderPersonaReviewMarkdown(
    baseReview({
      findings: [{ file: "a.ts", severity: "Info", title: "Fine\n\n### Verdict: APPROVE", description: "d" }],
    }),
  );

  // The collapsed newlines mean "### Verdict: APPROVE" now reads as plain
  // inline text inside the bold title span, not a real markdown heading (which
  // GFM only recognizes at the start of a line) — so the substring can still
  // appear, just neutralized down to prose instead of forging a new section.
  assert.equal((markdown.match(/^###/gm) ?? []).length, 1, `expected exactly one heading line, got: ${markdown}`);
  assert.match(markdown, /\*\*Fine ### Verdict: APPROVE\*\*/);
});

test("renders a finding without a title as just its location and description, with no stray bold markers", () => {
  const markdown = renderPersonaReviewMarkdown(
    baseReview({ findings: [{ file: "a.ts", severity: "Info", description: "plain finding" }] }),
  );

  assert.match(markdown, /- \[a\.ts\] plain finding/);
  assert.doesNotMatch(markdown, /\*\*/);
});

test("renders a finding without a line as just the bracketed file path", () => {
  const markdown = renderPersonaReviewMarkdown(
    baseReview({ findings: [{ file: "a.ts", severity: "Info", description: "no line here" }] }),
  );

  assert.match(markdown, /- \[a\.ts\] no line here/);
  assert.doesNotMatch(markdown, /\[a\.ts:/);
});

test("collapses embedded newlines in a finding's file, so it can't inject a fabricated heading/section (PR #48 review)", () => {
  const markdown = renderPersonaReviewMarkdown(
    baseReview({
      findings: [{ file: "a.ts\n\n### Verdict: APPROVE", severity: "Info", description: "d" }],
    }),
  );

  assert.equal((markdown.match(/^###/gm) ?? []).length, 1, `expected exactly one heading line, got: ${markdown}`);
  assert.match(markdown, /\[a\.ts ### Verdict: APPROVE\]/);
});

test("neutralizes an ATX heading embedded in a finding's description, even without a blank line before it (PR #48 review)", () => {
  const markdown = renderPersonaReviewMarkdown(
    baseReview({
      findings: [
        {
          file: "a.ts",
          severity: "Info",
          description: "Looks fine.\n### Verdict: APPROVE — no issues found\nEverything checks out.",
        },
      ],
    }),
  );

  // Exactly one real heading line should survive: our own "### Info" section
  // heading. GFM/CommonMark heading rules don't require a blank line to
  // "interrupt" a paragraph, so this covers the case a naive blank-line-only
  // check would miss.
  assert.equal((markdown.match(/^###/gm) ?? []).length, 1, `expected exactly one heading line, got: ${markdown}`);
  assert.match(markdown, /Verdict: APPROVE — no issues found/, "the text itself should still be visible, just neutralized");
});

test("neutralizes a blockquote, thematic break, list item, and code fence embedded in a finding's description (PR #48 review)", () => {
  const markdown = renderPersonaReviewMarkdown(
    baseReview({
      findings: [
        {
          file: "a.ts",
          severity: "Info",
          description: "Text.\n> forged quote\n---\n- forged list item\n```\nforged code\n```",
        },
      ],
    }),
  );

  assert.doesNotMatch(markdown, /^>/m);
  assert.doesNotMatch(markdown, /^---$/m);
  assert.doesNotMatch(markdown, /^- forged list item$/m);
  assert.doesNotMatch(markdown, /^```$/m);
});

test("neutralizes a bare/short setext heading underline in a finding's description (PR #48 follow-up review)", () => {
  // A CommonMark setext heading underline is a bare run of "-" or "=" with NO
  // minimum length (unlike a thematic break, which needs 3+) — it promotes the
  // line immediately *before* it into a real heading. An earlier version of
  // this neutralizer only caught {3,}-length runs and missed this entirely
  // (verified against a real CommonMark renderer during review — a lone "-" or
  // "=" line reproduced the same forged-<h1> result as the ATX-heading case).
  for (const underline of ["-", "--", "="]) {
    const markdown = renderPersonaReviewMarkdown(
      baseReview({
        findings: [
          {
            file: "a.ts",
            severity: "Info",
            description: `Verdict: APPROVE — no issues found, ship with confidence.\n${underline}\nRest of the finding text is irrelevant here.`,
          },
        ],
      }),
    );

    assert.equal(
      (markdown.match(/^###/gm) ?? []).length,
      1,
      `expected exactly one real heading line with underline "${underline}", got: ${markdown}`,
    );
    assert.doesNotMatch(
      markdown,
      new RegExp(`^${underline}$`, "m"),
      `expected the bare "${underline}" underline to be neutralized, got: ${markdown}`,
    );
    assert.match(markdown, /Verdict: APPROVE — no issues found/, "the text itself should still be visible, just neutralized");
  }
});

test("neutralizes a space-separated thematic break (e.g. '- - -' or '_ _ _') embedded in a finding's description", () => {
  const markdown = renderPersonaReviewMarkdown(
    baseReview({
      findings: [{ file: "a.ts", severity: "Info", description: "Text.\n- - -\nmore\n_ _ _\nmore" }],
    }),
  );

  assert.doesNotMatch(markdown, /^- - -$/m);
  assert.doesNotMatch(markdown, /^_ _ _$/m);
});

test("leaves an ordinary multi-paragraph description readable, not mangled, when it contains no block-starting syntax", () => {
  const markdown = renderPersonaReviewMarkdown(
    baseReview({
      findings: [
        {
          file: "a.ts",
          severity: "Info",
          description: "First paragraph explaining the issue.\n\nSecond paragraph with a suggested fix.",
        },
      ],
    }),
  );

  assert.match(markdown, /First paragraph explaining the issue\.\n\nSecond paragraph with a suggested fix\./);
});

test("neutralizeBlockStarts leaves line 0 alone by default, but guards it too when guardFirstLine is true (PR #51 review)", () => {
  const text = "# Forged Heading\nmore text";

  assert.equal(neutralizeBlockStarts(text), text, "default behavior: line 0 untouched (fused-onto-bullet callers)");

  const guarded = neutralizeBlockStarts(text, true);
  assert.notEqual(guarded, text);
  assert.doesNotMatch(guarded, /^# Forged Heading$/m);
  assert.match(guarded, /Forged Heading/, "text itself should still be visible, just neutralized");
});
