import { test, mock } from "node:test";
import assert from "node:assert/strict";

type Kind = "code-reviewer" | "security-auditor" | "test-generator";

interface RecordedCall {
  kind: Kind;
  startedAt: number;
}

let calls: RecordedCall[] = [];
let delaysMs: Partial<Record<Kind, number>> = {};
let errorsAfterMs: Partial<Record<Kind, number>> = {};

function classify(system: string): Kind {
  if (system === "CODE_REVIEWER_SYSTEM") return "code-reviewer";
  if (system === "SECURITY_AUDITOR_SYSTEM") return "security-auditor";
  return "test-generator";
}

// Mocks must be registered before the module under test is imported, since ESM
// bindings are resolved (and this file only imports ai-orchestrator.ts once) up
// front. Each test drives behavior through the shared `calls`/`delaysMs`/
// `errorsAfterMs` state instead of re-mocking per test.
mock.module("ai", {
  namedExports: {
    generateText: async (opts: { system: string }) => {
      const kind = classify(opts.system);
      calls.push({ kind, startedAt: Date.now() });
      const delay = delaysMs[kind] ?? errorsAfterMs[kind] ?? 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (errorsAfterMs[kind] !== undefined) {
        throw new Error(`${kind} failed`);
      }
      return { text: `${kind}-output` };
    },
  },
});

mock.module("../utils/model-factory.js", {
  namedExports: {
    createModel: () => ({ id: "mock-model" }),
  },
});

mock.module("./prompt-loader.js", {
  namedExports: {
    loadPersonaPrompt: async (id: "code-reviewer" | "security-auditor") => ({
      id,
      name: id,
      description: "mock persona",
      systemPrompt: id === "code-reviewer" ? "CODE_REVIEWER_SYSTEM" : "SECURITY_AUDITOR_SYSTEM",
    }),
  },
});

mock.module("./sandbox.js", {
  namedExports: {
    runInSandbox: async () => ({ ok: true, logs: [], errors: [] }),
  },
});

const { runReviewPipeline } = await import("./ai-orchestrator.js");

const baseInput = {
  filePath: "example.ts",
  astContext: "ctx",
  diff: "diff",
  provider: "anthropic" as const,
};

test("returns the codeReview/securityAudit/sandboxTest shape assembled from all three passes", async () => {
  calls = [];
  delaysMs = {};
  errorsAfterMs = {};

  const result = await runReviewPipeline(baseInput);

  assert.deepEqual(result, {
    codeReview: "code-reviewer-output",
    securityAudit: "security-auditor-output",
    sandboxTest: {
      code: "test-generator-output",
      result: { ok: true, logs: [], errors: [] },
    },
  });
});

test("kicks off sandbox test generation concurrently with the code-review/security-audit chain", async () => {
  calls = [];
  errorsAfterMs = {};
  // Slow down the code-review call so that, if the pipeline were still
  // sequential, the test-generator call couldn't start until after
  // security-auditor also finished. A concurrent pipeline starts the
  // test-generator call while code-review's delay is still pending.
  delaysMs = { "code-reviewer": 30 };

  await runReviewPipeline(baseInput);

  const order = calls.map((c) => c.kind);
  assert.deepEqual(order, ["code-reviewer", "test-generator", "security-auditor"]);
});

test("reports progress stages in the order the concurrent pipeline actually schedules work", async () => {
  calls = [];
  delaysMs = {};
  errorsAfterMs = {};
  const stages: string[] = [];

  await runReviewPipeline(baseInput, (stage) => stages.push(stage));

  assert.deepEqual(stages, ["loading-personas", "code-review", "sandbox-test", "security-audit"]);
});

test("a code-review failure doesn't leave the concurrent sandbox-test promise as an unhandled rejection", async () => {
  calls = [];
  delaysMs = {};
  // code-review fails fast; test-generator fails slower, after codeReviewPromise
  // has already rejected and runReviewPipeline has already exited. Without a
  // `.catch` on the floating sandbox-test promise, this rejection would have no
  // handler attached and crash the process moments later.
  errorsAfterMs = { "code-reviewer": 10, "test-generator": 50 };

  await assert.rejects(runReviewPipeline(baseInput), /code-reviewer failed/);

  // Stay alive past the test-generator's 50ms failure so that, if it were an
  // unhandled rejection, node's test runner attributes it to this still-running
  // test instead of it silently surfacing after the test (or the process) ends.
  await new Promise((resolve) => setTimeout(resolve, 80));
});
