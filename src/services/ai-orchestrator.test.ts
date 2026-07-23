import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { APICallError } from "ai";

type Kind = "code-reviewer" | "security-auditor" | "test-generator";

interface RecordedCall {
  kind: Kind;
  startedAt: number;
  systemText: string;
  systemPartCacheControl: boolean[];
  userText: string;
  hasSystemCacheControl: boolean;
  hasUserCacheControl: boolean;
  hasAbortSignal: boolean;
  timeoutMs: number | undefined;
  maxOutputTokens: number | undefined;
}

interface SystemPart {
  content: string;
  providerOptions?: unknown;
}

interface GenerateTextOpts {
  system: string | SystemPart | SystemPart[];
  messages: Array<{ content: Array<{ text: string; providerOptions?: unknown }> }>;
  abortSignal?: AbortSignal;
  timeout?: number;
  maxOutputTokens?: number;
}

// The persona's base prompt and the dynamic skill additions (skill-router.ts)
// are sent as separate system parts (an array) so the base prompt keeps its
// own cache breakpoint — see the comment on basePart in runPersona(). Tests
// below work with the combined text/cache-control state across every part.
function systemParts(system: GenerateTextOpts["system"]): SystemPart[] {
  if (typeof system === "string") return [{ content: system }];
  return Array.isArray(system) ? system : [system];
}

const FIXED_USAGE = {
  inputTokens: 100,
  inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 80, cacheWriteTokens: 10 },
  outputTokens: 50,
  outputTokenDetails: { textTokens: 50, reasoningTokens: 0 },
  totalTokens: 150,
};

let calls: RecordedCall[] = [];
let delaysMs: Partial<Record<Kind, number>> = {};
let errorsAfterMs: Partial<Record<Kind, number>> = {};
// Simulates generateText hitting maxOutputTokens (issue #33). `text` lets a
// test control whether the truncated response still has partial content or
// came back fully empty, since the two need different handling downstream.
let lengthTruncated: Partial<Record<Kind, { text: string }>> = {};
// A call that never resolves on its own — only settles once its abortSignal
// fires. Guarded by a long fallback timer so a regression in the abort wiring
// makes the assertion fail instead of hanging the test suite forever.
let hangUntilAborted: Partial<Record<Kind, boolean>> = {};
// Simulates Ollama's 404 "model not found" response.
let notFoundError: Partial<Record<Kind, boolean>> = {};
// Simulates an arbitrary non-2xx APICallError (e.g. the "Bad Request" from GH #22).
let badRequestError: Partial<Record<Kind, { responseBody?: string }>> = {};

function resetState(): void {
  calls = [];
  delaysMs = {};
  errorsAfterMs = {};
  hangUntilAborted = {};
  notFoundError = {};
  badRequestError = {};
  lengthTruncated = {};
}

function classify(system: GenerateTextOpts["system"]): Kind {
  const text = systemParts(system)[0]?.content ?? "";
  // The base persona part now has the output-efficiency instructions folded into
  // the same cached string (see the comment on basePart in runPersona()), so this
  // is a prefix match rather than exact equality.
  if (text.startsWith("CODE_REVIEWER_SYSTEM")) return "code-reviewer";
  if (text.startsWith("SECURITY_AUDITOR_SYSTEM")) return "security-auditor";
  return "test-generator";
}

// Mocks must be registered before the module under test is imported, since ESM
// bindings are resolved (and this file only imports ai-orchestrator.ts once) up
// front. Each test drives behavior through the shared `calls`/`delaysMs`/
// `errorsAfterMs`/etc. state instead of re-mocking per test.
mock.module("ai", {
  namedExports: {
    // ai-orchestrator.ts imports this alongside generateText, so it must be
    // re-exported here too — mock.module replaces the whole module rather than
    // merging with the real one. Reusing the real class (imported above, before
    // this mock takes effect) means APICallError.isInstance() still works on
    // errors thrown below.
    APICallError,
    generateText: async (opts: GenerateTextOpts) => {
      const kind = classify(opts.system);
      const parts = systemParts(opts.system);
      calls.push({
        kind,
        startedAt: Date.now(),
        systemText: parts.map((part) => part.content).join("\n\n"),
        systemPartCacheControl: parts.map((part) => part.providerOptions !== undefined),
        userText: opts.messages[0]?.content.map((part) => part.text).join("") ?? "",
        hasSystemCacheControl: parts.some((part) => part.providerOptions !== undefined),
        hasUserCacheControl: opts.messages[0]?.content[0]?.providerOptions !== undefined,
        hasAbortSignal: opts.abortSignal instanceof AbortSignal,
        timeoutMs: opts.timeout,
        maxOutputTokens: opts.maxOutputTokens,
      });

      if (hangUntilAborted[kind]) {
        await new Promise<void>((resolve, reject) => {
          const fallback = setTimeout(resolve, 5000);
          opts.abortSignal?.addEventListener("abort", () => {
            clearTimeout(fallback);
            reject(new Error(`${kind} aborted`));
          });
        });
      }

      const delay = delaysMs[kind] ?? errorsAfterMs[kind] ?? 0;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      if (notFoundError[kind]) {
        throw new APICallError({
          message: "Not Found",
          url: "http://127.0.0.1:11434/api/chat",
          requestBodyValues: {},
          statusCode: 404,
        });
      }
      if (badRequestError[kind]) {
        const { responseBody } = badRequestError[kind]!;
        throw new APICallError({
          message: "Bad Request",
          url: "http://127.0.0.1:11434/api/chat",
          requestBodyValues: {},
          statusCode: 400,
          ...(responseBody !== undefined ? { responseBody } : {}),
        });
      }
      if (errorsAfterMs[kind] !== undefined) {
        throw new Error(`${kind} failed`);
      }
      if (lengthTruncated[kind]) {
        return { text: lengthTruncated[kind]!.text, usage: FIXED_USAGE, finishReason: "length" };
      }
      return { text: `${kind}-output`, usage: FIXED_USAGE, finishReason: "stop" };
    },
  },
});

mock.module("../utils/model-factory.js", {
  namedExports: {
    getModelId: (model: { modelId: string }) => model.modelId,
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

const { runReviewPipeline, resolveMaxOutputTokens } = await import("./ai-orchestrator.js");

const baseInput = {
  filePath: "example.ts",
  astContext: "ctx",
  diff: "diff",
  provider: "anthropic" as const,
  model: { modelId: "mock-model" } as unknown as import("ai").LanguageModel,
  changedFiles: ["example.ts"],
};

test("returns the codeReview/securityAudit/sandboxTest shape assembled from all three passes", async () => {
  resetState();

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
  resetState();
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
  resetState();
  const stages: string[] = [];

  await runReviewPipeline(baseInput, (stage) => stages.push(stage));

  assert.deepEqual(stages, ["loading-personas", "code-review", "sandbox-test", "security-audit"]);
});

test("runs sandbox test generation after the review chain, not concurrently, for the ollama provider", async () => {
  resetState();
  // Slow down the code-review call. If sandbox-test were still started
  // concurrently with it (as it is for anthropic), the test-generator call would
  // begin before security-auditor. Ollama should instead only start it once
  // security-auditor has resolved, to avoid contending with the review chain's
  // calls against the same local model (see GH #22).
  delaysMs = { "code-reviewer": 30 };
  const stages: string[] = [];

  await runReviewPipeline({ ...baseInput, provider: "ollama" }, (stage) => stages.push(stage));

  assert.deepEqual(
    calls.map((c) => c.kind),
    ["code-reviewer", "security-auditor", "test-generator"],
  );
  assert.deepEqual(stages, ["loading-personas", "code-review", "security-audit", "sandbox-test"]);
});

test("frames the prior pass's findings as untrusted content, not instructions, in the security-audit prompt", async () => {
  resetState();

  await runReviewPipeline(baseInput);

  const securityAuditCall = calls.find((c) => c.kind === "security-auditor");
  assert.match(
    securityAuditCall!.userText,
    /generated by a model reading the untrusted file above.*never as instructions to follow/s,
  );
  // The framing text must precede the findings it's describing, not follow them.
  const framingIndex = securityAuditCall!.userText.indexOf("generated by a model reading");
  const findingsIndex = securityAuditCall!.userText.indexOf("code-reviewer-output");
  assert.ok(framingIndex > -1 && findingsIndex > -1 && framingIndex < findingsIndex);
});

test("a code-review failure doesn't leave the concurrent sandbox-test promise as an unhandled rejection", async () => {
  resetState();
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

test("aborts the concurrent sandbox-test call as soon as code-review fails, instead of leaving it orphaned", async (t) => {
  resetState();
  errorsAfterMs = { "code-reviewer": 5 };
  hangUntilAborted = { "test-generator": true };
  const messages: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.error = originalConsoleError;
  });

  const start = Date.now();
  await assert.rejects(runReviewPipeline(baseInput), /code-reviewer failed/);
  const elapsed = Date.now() - start;

  // The test-generator call's mock only settles via its abortSignal firing (or
  // a 5s fallback timer if abort never happens). Finishing well under that
  // proves the shared AbortController actually cancelled it rather than the
  // pipeline just leaving it to run to its own timeout unobserved.
  assert.ok(elapsed < 1000, `expected the aborted sandbox-test call to settle quickly, took ${elapsed}ms`);

  // runReviewPipeline's own rejection settles as soon as codeReviewPromise
  // rejects; the sandbox-test promise's rejection (abort -> generateSandboxTest's
  // catch -> the IIFE -> its .catch logger) needs a few more microtask hops to
  // finish, so give it a moment before checking the log.
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(
    messages.some((m) => m.includes("sandbox-test failed") && m.includes("aborted")),
    `expected the aborted sandbox-test failure to be logged, got: ${JSON.stringify(messages)}`,
  );
});

test("every generateText call is bounded by a numeric timeout and an abort signal", async () => {
  resetState();

  await runReviewPipeline(baseInput);

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.hasAbortSignal, true, `${call.kind} call is missing an abortSignal`);
    assert.equal(typeof call.timeoutMs, "number", `${call.kind} call is missing a numeric timeout`);
    assert.ok(call.timeoutMs! > 0, `${call.kind} call's timeout should be a positive bound`);
  }
});

test("rewraps an Ollama 404 model-not-found error into an actionable message", async () => {
  resetState();
  notFoundError = { "code-reviewer": true };

  await assert.rejects(
    runReviewPipeline({ ...baseInput, provider: "ollama" }),
    /Model "mock-model" not found on the Ollama instance.*ollama pull mock-model.*SCRUTINEER_MODEL_OLLAMA/s,
  );
});

test("enriches a non-404 APICallError with its status code and response body, instead of a bare message", async () => {
  resetState();
  badRequestError = { "code-reviewer": { responseBody: '{"error":"invalid request shape"}' } };

  await assert.rejects(
    runReviewPipeline({ ...baseInput, provider: "ollama" }),
    /Bad Request \(status 400\): \{"error":"invalid request shape"\}/,
  );
});

test("enriches a non-404 APICallError without a response body using just the status code", async () => {
  resetState();
  badRequestError = { "code-reviewer": {} };

  await assert.rejects(runReviewPipeline(baseInput), /Bad Request \(status 400\)$/);
});

test("leaves a non-404 error on the ollama provider unchanged, instead of misreporting it as model-not-found", async () => {
  resetState();
  errorsAfterMs = { "code-reviewer": 5 };

  await assert.rejects(runReviewPipeline({ ...baseInput, provider: "ollama" }), /^Error: code-reviewer failed$/);
});

test("marks the persona system prompt and the AST/diff user content as cacheable for the anthropic provider", async () => {
  resetState();

  await runReviewPipeline(baseInput);

  // code-reviewer and security-auditor both use a persona system prompt, so both
  // get system-level cache control; test-generator's system prompt is a hardcoded
  // string (not a persona), so it never does. All three share the same AST/diff
  // user content, so all three get user-level cache control.
  const byKind = Object.fromEntries(calls.map((c) => [c.kind, c]));
  assert.equal(byKind["code-reviewer"]?.hasSystemCacheControl, true);
  assert.equal(byKind["security-auditor"]?.hasSystemCacheControl, true);
  assert.equal(byKind["test-generator"]?.hasSystemCacheControl, false);
  assert.equal(byKind["code-reviewer"]?.hasUserCacheControl, true);
  assert.equal(byKind["security-auditor"]?.hasUserCacheControl, true);
  assert.equal(byKind["test-generator"]?.hasUserCacheControl, true);
});

test("omits cache-control metadata entirely for the ollama provider instead of erroring", async () => {
  resetState();

  await runReviewPipeline({ ...baseInput, provider: "ollama" });

  assert.ok(calls.every((c) => !c.hasSystemCacheControl && !c.hasUserCacheControl));
});

test("warns on stderr when the AST context or diff is truncated, instead of silently dropping content", async (t) => {
  resetState();
  const messages: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.error = originalConsoleError;
  });

  // A --diff batch concatenates every changed file's AST context into one string,
  // which is what makes crossing the 40K-char cap realistic in practice.
  await runReviewPipeline({ ...baseInput, astContext: "x".repeat(40_001) });

  const truncationWarnings = messages.filter(
    (m) => m.includes("AST context") && m.includes("example.ts") && m.includes("truncated"),
  );
  assert.equal(
    truncationWarnings.length,
    1,
    `expected exactly one truncation warning (the AST/diff block is built once per run and reused ` +
      `across all three model calls), got: ${JSON.stringify(messages)}`,
  );
});

test("warns on stderr and appends a visible notice when a persona response hits the output token cap with partial text (GH #33)", async (t) => {
  resetState();
  const messages: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.error = originalConsoleError;
  });
  lengthTruncated = { "code-reviewer": { text: "## Findings\nPartial review before the cap hit" } };

  const result = await runReviewPipeline(baseInput);

  assert.match(result.codeReview, /^## Findings\nPartial review before the cap hit/);
  assert.match(result.codeReview, /cut off after reaching the model's output token limit/);
  assert.ok(
    messages.some((m) => m.includes("code-review") && m.includes("output limit")),
    `expected an output-truncation warning, got: ${JSON.stringify(messages)}`,
  );
});

test("returns a clear truncation marker instead of a blank section when a persona response hits the cap with no text at all (GH #33)", async () => {
  resetState();
  lengthTruncated = { "code-reviewer": { text: "" } };

  const result = await runReviewPipeline(baseInput);

  assert.match(result.codeReview, /Review truncated.*output token budget/);
});

test("does not treat a normal, complete response as truncated", async () => {
  resetState();

  const result = await runReviewPipeline(baseInput);

  assert.equal(result.codeReview, "code-reviewer-output");
  assert.equal(result.securityAudit, "security-auditor-output");
});

test("warns on stderr but does not corrupt the sandbox test script when test-generation itself hits the output cap (GH #33)", async (t) => {
  resetState();
  const messages: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.error = originalConsoleError;
  });
  lengthTruncated = { "test-generator": { text: "console.log('PASS'" } };

  const result = await runReviewPipeline(baseInput);

  // stripCodeFences() output is untouched by the notice appended to persona
  // text above — appending prose here would produce invalid JS for the sandbox.
  assert.equal(result.sandboxTest.code, "console.log('PASS'");
  assert.ok(
    messages.some((m) => m.includes("sandbox-test") && m.includes("output limit")),
    `expected an output-truncation warning, got: ${JSON.stringify(messages)}`,
  );
});

test("injects React/Performance instructions into the code-reviewer prompt for frontend files, and nothing into security-auditor", async () => {
  resetState();

  await runReviewPipeline({ ...baseInput, changedFiles: ["src/app/page.tsx"] });

  const byKind = Object.fromEntries(calls.map((c) => [c.kind, c]));
  assert.match(byKind["code-reviewer"]!.systemText, /Dynamic Skill: React Architecture & Performance Auditor/);
  assert.doesNotMatch(byKind["security-auditor"]!.systemText, /Dynamic Skill/);
});

test("injects Type Wizard into code-reviewer and Backend Security Auditor into security-auditor for backend/data files", async () => {
  resetState();

  await runReviewPipeline({ ...baseInput, changedFiles: ["src/app/api/route.ts"] });

  const byKind = Object.fromEntries(calls.map((c) => [c.kind, c]));
  assert.match(byKind["code-reviewer"]!.systemText, /Dynamic Skill: Type Wizard/);
  assert.match(byKind["security-auditor"]!.systemText, /Dynamic Skill: Backend Security Auditor/);
});

test("injects Dependency & Environment Auditor into security-auditor for config files, and nothing into code-reviewer", async () => {
  resetState();

  await runReviewPipeline({ ...baseInput, changedFiles: ["package.json"] });

  const byKind = Object.fromEntries(calls.map((c) => [c.kind, c]));
  assert.doesNotMatch(byKind["code-reviewer"]!.systemText, /Dynamic Skill/);
  assert.match(byKind["security-auditor"]!.systemText, /Dynamic Skill: Dependency & Environment Auditor/);
});

test("injects nothing when no changed file matches a dynamic skill category", async () => {
  resetState();

  await runReviewPipeline({ ...baseInput, changedFiles: ["src/services/example.ts"] });

  const byKind = Object.fromEntries(calls.map((c) => [c.kind, c]));
  assert.doesNotMatch(byKind["code-reviewer"]!.systemText, /Dynamic Skill/);
  assert.doesNotMatch(byKind["security-auditor"]!.systemText, /Dynamic Skill/);
});

test("keeps the persona's base prompt (now including the folded-in output-efficiency instructions) as its own cache breakpoint, separate from the dynamic skill additions", async () => {
  resetState();

  await runReviewPipeline({ ...baseInput, changedFiles: ["src/app/page.tsx"] });

  // The base persona prompt (part 0, now with OUTPUT_EFFICIENCY_INSTRUCTIONS
  // folded into the same cached string — see the comment on basePart in
  // runPersona()) is cache-controlled independently of whatever dynamic
  // additions get appended (part 1, uncached — those vary per diff, so caching
  // them would pay a cache-write cost for content unlikely to be reused across
  // runs).
  const codeReviewer = calls.find((c) => c.kind === "code-reviewer")!;
  assert.deepEqual(codeReviewer.systemPartCacheControl, [true, false]);
});

test("keeps the persona system prompt as a single cache-controlled part when no dynamic skill category is triggered", async () => {
  resetState();

  await runReviewPipeline(baseInput);

  const codeReviewer = calls.find((c) => c.kind === "code-reviewer")!;
  assert.deepEqual(codeReviewer.systemPartCacheControl, [true]);
});

test("appends output-efficiency instructions to both review personas, but not to test-generation (whose output is executable JS, not prose)", async () => {
  resetState();

  await runReviewPipeline(baseInput);

  const byKind = Object.fromEntries(calls.map((c) => [c.kind, c]));
  assert.match(byKind["code-reviewer"]!.systemText, /Output Efficiency/);
  assert.match(byKind["security-auditor"]!.systemText, /Output Efficiency/);
  assert.doesNotMatch(byKind["test-generator"]!.systemText, /Output Efficiency/);
});

test("resolveMaxOutputTokens: base case, linear scaling, zero/negative-safe input, and the ceiling clamp", () => {
  // Hardcoded literals rather than deriving "expected" from the function under
  // test itself, so a regression in the constants (BASE_OUTPUT_TOKENS,
  // PER_ADDITIONAL_FILE_OUTPUT_TOKENS, OUTPUT_TOKENS_CEILING) actually fails
  // this test instead of just being self-consistent with a changed formula.
  assert.equal(resolveMaxOutputTokens(0), 4096, "0 files (not reachable today, but shouldn't crash or go negative)");
  assert.equal(resolveMaxOutputTokens(1), 4096, "single-file review keeps the pre-#33 default");
  assert.equal(resolveMaxOutputTokens(2), 4352, "one additional file adds exactly one PER_ADDITIONAL_FILE increment");
  assert.equal(resolveMaxOutputTokens(17), 8192, "the 17-file batch from issue #33's repro");
  assert.equal(resolveMaxOutputTokens(49), 16384, "unclamped formula lands exactly on the ceiling at 49 files");
  assert.equal(resolveMaxOutputTokens(50), 16384, "50 files would exceed the ceiling unclamped — proves Math.min is actually clamping, not coincidentally equal");
  assert.equal(resolveMaxOutputTokens(500), 16384, "a pathological batch size stays clamped at the ceiling");
});

test("scales the output token cap with the number of changed files in the --diff batch, instead of a flat constant, and shares it across all three calls", async () => {
  resetState();

  await runReviewPipeline({
    ...baseInput,
    changedFiles: Array.from({ length: 17 }, (_, i) => `src/file${i}.ts`),
  });

  // 4096 (base) + 16 additional files * 256 = 8192 — the 17-file batch from
  // issue #33 that silently produced an empty review under the old flat 4096 cap.
  for (const call of calls) {
    assert.equal(call.maxOutputTokens, 8192, `${call.kind} call should use the scaled cap`);
  }
});

test("caps the scaled output token budget at a fixed 16384 ceiling instead of growing without bound for a pathological batch size", async () => {
  resetState();

  await runReviewPipeline({ ...baseInput, changedFiles: Array.from({ length: 500 }, (_, i) => `file${i}.ts`) });

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.maxOutputTokens, 16384);
  }
});

test("uses the base output token cap (4096) for a single-file review, matching the pre-#33 default", async () => {
  resetState();

  await runReviewPipeline(baseInput);

  for (const call of calls) {
    assert.equal(call.maxOutputTokens, 4096);
  }
});
