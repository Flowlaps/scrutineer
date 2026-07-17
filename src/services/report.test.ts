import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReportMarkdown, codeFence } from "./report.js";
import type { ReviewResult } from "./ai-orchestrator.js";

function fakeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    codeReview: "## Review Summary\n\nLooks fine.",
    securityAudit: "## Security Audit Report\n\nNo findings.",
    sandboxTest: {
      code: 'console.log("PASS");',
      result: { ok: true, logs: ["PASS"], errors: [] },
    },
    ...overrides,
  };
}

test("includes file, provider, and both review sections", () => {
  const markdown = buildReportMarkdown({
    filePath: "src/index.ts",
    provider: "anthropic",
    result: fakeResult(),
    generatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.match(markdown, /# Scrutineer Review Report/);
  assert.match(markdown, /\*\*File:\*\* `src\/index\.ts`/);
  assert.match(markdown, /\*\*Provider:\*\* anthropic/);
  assert.match(markdown, /\*\*Generated:\*\* 2026-01-01T00:00:00\.000Z/);
  assert.match(markdown, /## Code Review/);
  assert.match(markdown, /Looks fine\./);
  assert.match(markdown, /## Security Audit/);
  assert.match(markdown, /No findings\./);
});

test("reports PASS and omits Errors section when the sandbox succeeds", () => {
  const markdown = buildReportMarkdown({
    filePath: "f.ts",
    provider: "ollama",
    result: fakeResult(),
  });

  assert.match(markdown, /\*\*Result:\*\* PASS/);
  assert.match(markdown, /\*\*Logs:\*\*\n\n- PASS/);
  assert.doesNotMatch(markdown, /\*\*Errors:\*\*/);
});

test("reports FAILED and includes an Errors section when the sandbox fails", () => {
  const markdown = buildReportMarkdown({
    filePath: "f.ts",
    provider: "anthropic",
    result: fakeResult({
      sandboxTest: {
        code: "throw new Error('boom');",
        result: { ok: false, logs: [], errors: ["boom"] },
      },
    }),
  });

  assert.match(markdown, /\*\*Result:\*\* FAILED/);
  assert.match(markdown, /\*\*Errors:\*\*\n\n- boom/);
  assert.doesNotMatch(markdown, /\*\*Logs:\*\*/);
});

test("codeFence picks a longer fence when the code contains backticks", () => {
  assert.equal(codeFence("plain code, no backticks"), "```");
  assert.equal(codeFence("has a ``` triple backtick already"), "````");
  assert.equal(codeFence("has ```` four backticks"), "`````");
});

test("a generated test containing its own fence doesn't break the report", () => {
  const trickyCode = 'console.log("```js\\nnested\\n```");';
  const markdown = buildReportMarkdown({
    filePath: "f.ts",
    provider: "anthropic",
    result: fakeResult({ sandboxTest: { code: trickyCode, result: { ok: true, logs: [], errors: [] } } }),
  });

  // The fence around the code block must be longer than any backtick run
  // inside it, or the embedded ``` would prematurely close the block.
  const fence = codeFence(trickyCode);
  assert.ok(fence.length > 3);
  assert.match(markdown, new RegExp(`${fence}js\\n${trickyCode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n${fence}`));
});
