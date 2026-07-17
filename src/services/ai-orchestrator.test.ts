import { test, mock } from "node:test";
import assert from "node:assert/strict";

type Kind = "code-reviewer" | "security-auditor" | "test-generator";

interface RecordedCall {
  kind: Kind;
  startedAt: number;
}

let calls: RecordedCall[] = [];
let delaysMs: Partial<Record<Kind, number>> = {};

function classify(system: string): Kind {
  if (system === "CODE_REVIEWER_SYSTEM") return "code-reviewer";
  if (system === "SECURITY_AUDITOR_SYSTEM") return "security-auditor";
  return "test-generator";
}

// Mocks must be registered before the module under test is imported, since ESM
// bindings are resolved (and this file only imports ai-orchestrator.ts once) up
// front. Each test drives behavior through the shared `calls`/`delaysMs` state
// instead of re-mocking per test.
mock.module("ai", {
  namedExports: {
    generateText: async (opts: { system: string }) => {
      const kind = classify(opts.system);
      calls.push({ kind, startedAt: Date.now() });
      const delay = delaysMs[kind] ?? 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
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
  const stages: string[] = [];

  await runReviewPipeline(baseInput, (stage) => stages.push(stage));

  assert.deepEqual(stages, ["loading-personas", "code-review", "sandbox-test", "security-audit"]);
});
