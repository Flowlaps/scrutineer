import { test } from "node:test";
import assert from "node:assert/strict";
import { buildInlineReview } from "./inline-review.js";
import type { ReviewResult } from "./ai-orchestrator.js";
import type { PersonaReview } from "./review-schema.js";

const DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,4 @@",
  " line1",
  "-line2 old",
  "+line2 new",
  "+line2.5 new",
  " line3",
  "",
].join("\n");

function personaReview(overrides: Partial<PersonaReview> = {}): PersonaReview {
  return { summary: "", findings: [], positiveObservations: [], additionalNotes: [], ...overrides };
}

function fakeResult(overrides: {
  codeReview?: Partial<PersonaReview>;
  securityAudit?: Partial<PersonaReview>;
} = {}): ReviewResult {
  return {
    codeReview: { markdown: "", review: personaReview(overrides.codeReview) },
    securityAudit: { markdown: "", review: personaReview(overrides.securityAudit) },
    sandboxTest: { code: 'console.log("PASS");', result: { ok: true, logs: ["PASS"], errors: [] } },
  };
}

test("a finding whose line falls inside a hunk becomes an inline comment, not part of the body", () => {
  const result = fakeResult({
    codeReview: {
      findings: [{ file: "src/foo.ts", line: 2, severity: "Critical", title: "Bug", description: "Broken." }],
    },
  });

  const { body, comments } = buildInlineReview(result, DIFF);

  assert.equal(comments.length, 1);
  assert.deepEqual(
    { path: comments[0]?.path, line: comments[0]?.line },
    { path: "src/foo.ts", line: 2 },
  );
  assert.match(comments[0]?.body ?? "", /\*\*Code Review — Critical: Bug\*\*/);
  assert.match(comments[0]?.body ?? "", /Broken\./);
  assert.doesNotMatch(body, /Broken\./);
});

test("a finding whose line falls outside every hunk is dropped to the cover-note body instead of a comment", () => {
  const result = fakeResult({
    securityAudit: {
      findings: [{ file: "src/foo.ts", line: 999, severity: "High", description: "Out of diff range." }],
    },
  });

  const { body, comments } = buildInlineReview(result, DIFF);

  assert.equal(comments.length, 0);
  assert.match(body, /### Additional Findings/);
  assert.match(body, /\[src\/foo\.ts\] \*\*Security Audit — High\*\*/);
  assert.match(body, /Out of diff range\./);
});

test("a finding with no line at all is treated as file-level and homed in the body", () => {
  const result = fakeResult({
    codeReview: { findings: [{ file: "src/foo.ts", severity: "Info", description: "General note." }] },
  });

  const { body, comments } = buildInlineReview(result, DIFF);

  assert.equal(comments.length, 0);
  assert.match(body, /\[src\/foo\.ts\] \*\*Code Review — Info\*\*/);
  assert.match(body, /General note\./);
});

test("cover note includes verdict, per-persona severity counts, and the Sandbox Test section", () => {
  const result = fakeResult({
    codeReview: {
      verdict: "REQUEST CHANGES",
      findings: [{ file: "src/foo.ts", line: 2, severity: "Critical", description: "d1" }],
    },
    securityAudit: {
      findings: [
        { file: "src/foo.ts", line: 2, severity: "High", description: "d2" },
        { file: "src/foo.ts", line: 2, severity: "High", description: "d3" },
      ],
    },
  });

  const { body } = buildInlineReview(result, DIFF);

  assert.match(body, /\*\*Verdict:\*\* REQUEST CHANGES/);
  assert.match(body, /\*\*Code Review:\*\* 1 finding\(s\) \(1 Critical\)/);
  assert.match(body, /\*\*Security Audit:\*\* 2 finding\(s\) \(2 High\)/);
  assert.match(body, /## Sandbox Test/);
  assert.match(body, /\*\*Result:\*\* PASS/);
});

test("cover note reports no findings for a persona with an empty findings array", () => {
  const { body } = buildInlineReview(fakeResult(), DIFF);
  assert.match(body, /\*\*Code Review:\*\* no findings/);
  assert.match(body, /\*\*Security Audit:\*\* no findings/);
  assert.doesNotMatch(body, /### Additional Findings/);
});
