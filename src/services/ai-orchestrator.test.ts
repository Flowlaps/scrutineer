import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { APICallError, NoObjectGeneratedError } from "ai";
import type { PersonaReview, ReviewFinding } from "./review-schema.js";

type Kind = "code-reviewer" | "security-auditor" | "test-generator";
// The two review personas go through generateObject; test-generator (sandbox
// test generation) still goes through generateText, unchanged by this file's
// migration to structured findings (see ai-orchestrator.ts's runPersona).
type PersonaKind = "code-reviewer" | "security-auditor";

interface RecordedCall {
  kind: Kind;
  startedAt: number;
  systemText: string;
  systemPartCacheControl: boolean[];
  userText: string;
  hasSystemCacheControl: boolean;
  hasUserCacheControl: boolean;
  hasAbortSignal: boolean;
  // Only ever set for test-generator's generateText call — generateObject's
  // options type has no `timeout` field (see the comment on the boundedSignal
  // in runPersona()), so a persona call's timeout bound lives inside its
  // abortSignal instead of as its own recorded property.
  timeoutMs: number | undefined;
  maxOutputTokens: number | undefined;
}

interface SystemPart {
  content: string;
  providerOptions?: unknown;
}

interface CommonCallOpts {
  system: string | SystemPart | SystemPart[];
  messages: Array<{ content: Array<{ text: string; providerOptions?: unknown }> }>;
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
}

interface GenerateTextOpts extends CommonCallOpts {
  timeout?: number;
}

interface GenerateObjectOpts extends CommonCallOpts {
  schema: unknown;
}

// The persona's base prompt and the dynamic skill additions (skill-router.ts)
// are sent as separate system parts (an array) so the base prompt keeps its
// own cache breakpoint — see the comment on basePart in runPersona(). Tests
// below work with the combined text/cache-control state across every part.
function systemParts(system: CommonCallOpts["system"]): SystemPart[] {
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

const FIXED_RESPONSE_METADATA = { id: "mock-response", timestamp: new Date(0), modelId: "mock-model" };

function defaultReview(kind: PersonaKind): PersonaReview {
  // Renders (via renderPersonaReviewMarkdown) to exactly "${kind}-output" —
  // every other field is empty/unset, so aggregate()'s markdown output stays
  // byte-identical to this suite's pre-structured-output expectations.
  return { summary: `${kind}-output`, findings: [], positiveObservations: [], additionalNotes: [] };
}

let calls: RecordedCall[] = [];
let delaysMs: Partial<Record<Kind, number>> = {};
let errorsAfterMs: Partial<Record<Kind, number>> = {};
// Simulates generateText (test-generator only) hitting maxOutputTokens (issue
// #33). `text` lets a test control whether the truncated response still has
// partial content or came back fully empty, since the two need different
// handling downstream.
let lengthTruncated: Partial<Record<Kind, { text: string }>> = {};
// Simulates generateObject's own truncation failure modes (issue #33's
// structured-output counterpart — see runPersona's NoObjectGeneratedError
// handling): "unparseable" throws NoObjectGeneratedError with finishReason
// "length" (the realistic case — truncated JSON usually fails schema
// validation outright); "parsed" returns a valid object that still happens to
// report finishReason "length" (the model finished its JSON right as the
// budget ran out).
let objectLengthTruncated: Partial<Record<PersonaKind, "unparseable" | "parsed">> = {};
// A call that never resolves on its own — only settles once its abortSignal
// fires. Guarded by a long fallback timer so a regression in the abort wiring
// makes the assertion fail instead of hanging the test suite forever.
let hangUntilAborted: Partial<Record<Kind, boolean>> = {};
// Tracks how many code-reviewer/security-auditor calls are simultaneously
// in flight (test-generator excluded — it's a single, separately-scheduled
// call, not part of the chunk concurrency being measured), so chunked-pipeline
// tests can assert real concurrency bounds instead of just call ordering.
let activePersonaCalls = 0;
let maxObservedPersonaConcurrency = 0;
// Simulates Ollama's 404 "model not found" response.
let notFoundError: Partial<Record<Kind, boolean>> = {};
// Simulates an arbitrary non-2xx APICallError (e.g. the "Bad Request" from GH #22).
let badRequestError: Partial<Record<Kind, { responseBody?: string }>> = {};
// Lets a test control a persona's exact returned summary, instead of the
// default "${kind}-output" placeholder — needed to exercise how
// runChunkedReviewPipeline's aggregate() handles model output containing
// HTML-structural text (PR #43 review).
let customOutputText: Partial<Record<PersonaKind, string>> = {};
// Lets a test control a persona's exact returned `findings` array per call,
// instead of the default empty array — needed to exercise
// runChunkedReviewPipeline's cross-chunk dedup (issue #46 step 5), where each
// chunk's call to the same persona needs to return different findings. Each
// kind's array is a queue: one entry consumed (shifted) per call to that
// persona, in call order — the first chunk's code-reviewer call gets index 0,
// the second chunk's gets index 1, and so on.
let customFindingsQueue: Partial<Record<PersonaKind, ReviewFinding[][]>> = {};

function resetState(): void {
  calls = [];
  delaysMs = {};
  errorsAfterMs = {};
  hangUntilAborted = {};
  notFoundError = {};
  badRequestError = {};
  lengthTruncated = {};
  objectLengthTruncated = {};
  customOutputText = {};
  customFindingsQueue = {};
  activePersonaCalls = 0;
  maxObservedPersonaConcurrency = 0;
}

function classify(system: CommonCallOpts["system"]): Kind {
  const text = systemParts(system)[0]?.content ?? "";
  // The base persona part now has the output-efficiency instructions and the
  // schema-mapping bridge folded into the same cached string (see the comment
  // on basePart in runPersona()), so this is a prefix match rather than exact
  // equality.
  if (text.startsWith("CODE_REVIEWER_SYSTEM")) return "code-reviewer";
  if (text.startsWith("SECURITY_AUDITOR_SYSTEM")) return "security-auditor";
  return "test-generator";
}

function recordCall(kind: Kind, opts: CommonCallOpts, timeoutMs: number | undefined): void {
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
    timeoutMs,
    maxOutputTokens: opts.maxOutputTokens,
  });
}

// Shared setup/error-simulation for both mocked calls below: tracks
// concurrency, waits out hangUntilAborted/delaysMs, and throws the configured
// APICallError/generic error. Returns `true` once the caller should proceed to
// its own (generateText- or generateObject-shaped) success/truncation branch.
async function runSharedSetup(kind: Kind, abortSignal: AbortSignal | undefined): Promise<void> {
  const tracksConcurrency = kind !== "test-generator";
  if (tracksConcurrency) {
    activePersonaCalls++;
    maxObservedPersonaConcurrency = Math.max(maxObservedPersonaConcurrency, activePersonaCalls);
  }
  if (hangUntilAborted[kind]) {
    await new Promise<void>((resolve, reject) => {
      const fallback = setTimeout(resolve, 5000);
      abortSignal?.addEventListener("abort", () => {
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
}

// Mocks must be registered before the module under test is imported, since ESM
// bindings are resolved (and this file only imports ai-orchestrator.ts once) up
// front. Each test drives behavior through the shared `calls`/`delaysMs`/
// `errorsAfterMs`/etc. state instead of re-mocking per test.
mock.module("ai", {
  namedExports: {
    // ai-orchestrator.ts imports these alongside generateText/generateObject,
    // so they must be re-exported here too — mock.module replaces the whole
    // module rather than merging with the real one. Reusing the real classes
    // (imported above, before this mock takes effect) means
    // APICallError.isInstance()/NoObjectGeneratedError.isInstance() still work
    // on errors thrown below.
    APICallError,
    NoObjectGeneratedError,
    generateText: async (opts: GenerateTextOpts) => {
      const kind = classify(opts.system);
      recordCall(kind, opts, opts.timeout);
      try {
        await runSharedSetup(kind, opts.abortSignal);
        if (lengthTruncated[kind]) {
          return { text: lengthTruncated[kind]!.text, usage: FIXED_USAGE, finishReason: "length" };
        }
        return { text: `${kind}-output`, usage: FIXED_USAGE, finishReason: "stop" };
      } finally {
        if (kind !== "test-generator") {
          activePersonaCalls--;
        }
      }
    },
    generateObject: async (opts: GenerateObjectOpts) => {
      const kind = classify(opts.system) as PersonaKind;
      recordCall(kind, opts, undefined);
      try {
        await runSharedSetup(kind, opts.abortSignal);
        if (objectLengthTruncated[kind] === "unparseable") {
          throw new NoObjectGeneratedError({
            message: "No object generated: response did not match schema.",
            response: FIXED_RESPONSE_METADATA,
            usage: FIXED_USAGE,
            finishReason: "length",
          });
        }
        const queuedFindings = customFindingsQueue[kind]?.shift();
        const object: PersonaReview = {
          ...defaultReview(kind),
          ...(customOutputText[kind] ? { summary: customOutputText[kind]! } : {}),
          ...(queuedFindings ? { findings: queuedFindings } : {}),
        };
        const finishReason = objectLengthTruncated[kind] === "parsed" ? "length" : "stop";
        return { object, usage: FIXED_USAGE, finishReason };
      } finally {
        activePersonaCalls--;
      }
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

const {
  runReviewPipeline,
  resolveMaxOutputTokens,
  runChunkedReviewPipeline,
  MAX_CONCURRENT_CHUNKS,
  mapWithConcurrencyLimit,
  dedupeFindings,
} = await import("./ai-orchestrator.js");

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
    codeReview: { markdown: "code-reviewer-output", review: defaultReview("code-reviewer") },
    securityAudit: { markdown: "security-auditor-output", review: defaultReview("security-auditor") },
    sandboxTest: {
      code: "test-generator-output",
      result: { ok: true, logs: [], errors: [] },
    },
    truncations: [],
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

test("every call is bounded by an abort signal, and the generateText (test-generator) call also carries an explicit numeric timeout", async () => {
  resetState();

  await runReviewPipeline(baseInput);

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.hasAbortSignal, true, `${call.kind} call is missing an abortSignal`);
    if (call.kind === "test-generator") {
      // generateText accepts a `timeout` option directly.
      assert.equal(typeof call.timeoutMs, "number", `${call.kind} call is missing a numeric timeout`);
      assert.ok(call.timeoutMs! > 0, `${call.kind} call's timeout should be a positive bound`);
    } else {
      // generateObject has no `timeout` option — the bound lives inside the
      // combined abortSignal itself instead (see runPersona's boundedSignal).
      assert.equal(call.timeoutMs, undefined, `${call.kind} call unexpectedly recorded a generateText-style timeout`);
    }
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

test("warns on stderr and appends a visible notice when a persona response hits the output token cap but still parses (GH #33)", async (t) => {
  resetState();
  const messages: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.error = originalConsoleError;
  });
  // The model finished valid JSON right as the token budget ran out — rare,
  // but generateObject can still report finishReason "length" on a call whose
  // object parsed successfully (see withTruncationNotice in ai-orchestrator.ts).
  objectLengthTruncated = { "code-reviewer": "parsed" };

  const result = await runReviewPipeline(baseInput);

  assert.match(result.codeReview.markdown, /^code-reviewer-output/);
  assert.match(result.codeReview.markdown, /cut off after reaching the model's output token limit/);
  assert.ok(
    messages.some((m) => m.includes("code-review") && m.includes("output limit")),
    `expected an output-truncation warning, got: ${JSON.stringify(messages)}`,
  );
});

test("returns a clear truncation marker instead of a blank section when a persona response hits the cap and can't be parsed at all (GH #33)", async (t) => {
  resetState();
  const messages: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.error = originalConsoleError;
  });
  // The realistic truncation failure mode: JSON cut off mid-object fails schema
  // validation outright, surfacing as NoObjectGeneratedError rather than a
  // successful (if incomplete) parse.
  objectLengthTruncated = { "code-reviewer": "unparseable" };

  const result = await runReviewPipeline(baseInput);

  assert.match(result.codeReview.markdown, /Review truncated.*output token budget/);
  assert.ok(
    messages.some((m) => m.includes("code-review") && m.includes("output limit") && m.includes("could not")),
    `expected an output-truncation warning, got: ${JSON.stringify(messages)}`,
  );
});

test("does not treat a normal, complete response as truncated", async () => {
  resetState();

  const result = await runReviewPipeline(baseInput);

  assert.equal(result.codeReview.markdown, "code-reviewer-output");
  assert.equal(result.securityAudit.markdown, "security-auditor-output");
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

test("appends report-proportionality instructions to both review personas, but not to test-generation", async () => {
  resetState();

  await runReviewPipeline(baseInput);

  const byKind = Object.fromEntries(calls.map((c) => [c.kind, c]));
  assert.match(byKind["code-reviewer"]!.systemText, /Report Proportionality/);
  assert.match(byKind["security-auditor"]!.systemText, /Report Proportionality/);
  assert.doesNotMatch(byKind["test-generator"]!.systemText, /Report Proportionality/);
});

test("resolveMaxOutputTokens: base case, linear scaling, zero/negative-safe input, and the ceiling clamp", () => {
  // Hardcoded literals rather than deriving "expected" from the function under
  // test itself, so a regression in the constants (BASE_OUTPUT_TOKENS,
  // PER_ADDITIONAL_FILE_OUTPUT_TOKENS, OUTPUT_TOKENS_CEILING) actually fails
  // this test instead of just being self-consistent with a changed formula.
  // BASE_OUTPUT_TOKENS/OUTPUT_TOKENS_CEILING were doubled (8192/32768) for issue
  // #46's move to generateObject, whose structured/tool-call output measured
  // meaningfully more expensive than the old free-text budget on a real call
  // (see the comment on BASE_OUTPUT_TOKENS in ai-orchestrator.ts). With the
  // same 1:4 ratio preserved, PER_ADDITIONAL_FILE_OUTPUT_TOKENS is now
  // ceil((32768 - 8192) / (10 - 1)) = 2731, so the ceiling still lands right at
  // MAX_FILES_PER_CHUNK (10) — the largest file count a single chunk ever
  // actually sees.
  assert.equal(resolveMaxOutputTokens(0), 8192, "0 files (not reachable today, but shouldn't crash or go negative)");
  assert.equal(resolveMaxOutputTokens(1), 8192, "single-file review keeps the base budget");
  assert.equal(resolveMaxOutputTokens(2), 10923, "one additional file adds exactly one PER_ADDITIONAL_FILE increment");
  assert.equal(resolveMaxOutputTokens(9), 30040, "just under the max chunk size stays just under the ceiling, unclamped");
  assert.equal(
    resolveMaxOutputTokens(10),
    32768,
    "a full-size chunk (MAX_FILES_PER_CHUNK) now reaches the full ceiling instead of using only a fraction of it (issue #39)",
  );
  assert.equal(resolveMaxOutputTokens(17), 32768, "the 17-file batch from issue #33's repro — now chunked, but the raw formula still clamps correctly");
  assert.equal(resolveMaxOutputTokens(50), 32768, "50 files would exceed the ceiling unclamped — proves Math.min is actually clamping, not coincidentally equal");
  assert.equal(resolveMaxOutputTokens(500), 32768, "a pathological batch size stays clamped at the ceiling");
});

test("scales the output token cap with the number of changed files in the --diff batch, instead of a flat constant, and shares it across all three calls", async () => {
  resetState();

  await runReviewPipeline({
    ...baseInput,
    changedFiles: Array.from({ length: 5 }, (_, i) => `src/file${i}.ts`),
  });

  // 8192 (base) + 4 additional files * 2731 = 19116 — a batch small enough that
  // the scaled cap isn't clamped by the ceiling, so this actually exercises the
  // scaling formula rather than the clamp (which the ceiling test below covers).
  for (const call of calls) {
    assert.equal(call.maxOutputTokens, 19116, `${call.kind} call should use the scaled cap`);
  }
});

test("caps the scaled output token budget at a fixed 32768 ceiling instead of growing without bound for a pathological batch size", async () => {
  resetState();

  await runReviewPipeline({ ...baseInput, changedFiles: Array.from({ length: 500 }, (_, i) => `file${i}.ts`) });

  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.maxOutputTokens, 32768);
  }
});

test("uses the base output token cap (8192) for a single-file review", async () => {
  resetState();

  await runReviewPipeline(baseInput);

  for (const call of calls) {
    assert.equal(call.maxOutputTokens, 8192);
  }
});

// runChunkedReviewPipeline (issue #35) — --diff batches too large for a single
// call's output-token ceiling, split into multiple smaller review calls and
// aggregated back into one ReviewResult. Reuses the exact same "ai" mock as
// runReviewPipeline's tests above; no new mocking infrastructure needed beyond
// the activePersonaCalls/maxObservedPersonaConcurrency tracking added to it.

const chunkedBaseInput = {
  filePath: "23 file(s) changed vs origin/main",
  provider: "anthropic" as const,
  model: { modelId: "mock-model" } as unknown as import("ai").LanguageModel,
  fullAstContext: "full-batch-ctx",
  fullDiff: "full-batch-diff",
  changedFiles: ["a.ts", "b.ts"],
  chunks: [
    { label: "Chunk 1/2 (1 file) vs origin/main", changedFiles: ["a.ts"], astContext: "CHUNK_A_CTX", diff: "CHUNK_A_DIFF" },
    { label: "Chunk 2/2 (1 file) vs origin/main", changedFiles: ["b.ts"], astContext: "CHUNK_B_CTX", diff: "CHUNK_B_DIFF" },
  ],
};

test("aggregates each chunk's codeReview/securityAudit under its own collapsed <details> disclosure, in order", async () => {
  resetState();

  const result = await runChunkedReviewPipeline(chunkedBaseInput);

  const chunk1Summary = "<summary>Chunk 1/2 (1 file(s): a.ts)</summary>";
  const chunk2Summary = "<summary>Chunk 2/2 (1 file(s): b.ts)</summary>";
  for (const text of [result.codeReview.markdown, result.securityAudit.markdown]) {
    assert.ok(text.includes(chunk1Summary), `expected "${chunk1Summary}" in: ${text}`);
    assert.ok(text.includes(chunk2Summary), `expected "${chunk2Summary}" in: ${text}`);
    assert.ok(text.indexOf(chunk1Summary) < text.indexOf(chunk2Summary), "chunk 1 should appear before chunk 2");
    assert.ok((text.match(/<details>/g) ?? []).length === 2, "expected one <details> block per chunk");
  }
});

test("HTML-escapes a chunk's changed file names in the <summary> line, so an untrusted filename can't break out of it (PR #43 review)", async () => {
  resetState();

  const result = await runChunkedReviewPipeline({
    ...chunkedBaseInput,
    chunks: [
      {
        label: "Chunk 1/1",
        changedFiles: ["x</summary><h1>evil.ts"],
        astContext: "ctx",
        diff: "diff",
      },
    ],
  });

  for (const text of [result.codeReview.markdown, result.securityAudit.markdown]) {
    assert.doesNotMatch(text, /<h1>evil\.ts/, `expected the injected <h1> to be escaped, not raw HTML, in: ${text}`);
    assert.match(text, /x&lt;\/summary&gt;&lt;h1&gt;evil\.ts/);
    // Exactly one real <summary>...</summary> pair should survive — the
    // injected one must read as escaped text, not a second real tag.
    assert.equal((text.match(/<summary>/g) ?? []).length, 1);
  }
});

test("neutralizes a literal '</details>' inside a persona's own findings text, so it can't prematurely close our wrapper (PR #43 review)", async () => {
  resetState();
  customOutputText["code-reviewer"] = "Finding: this file's own </details> tag usage is worth reviewing.";

  const result = await runChunkedReviewPipeline(chunkedBaseInput);

  // Exactly one literal "</details>" per chunk should remain — our own
  // wrapper's closing tag. The one embedded in the persona's text must have
  // been neutralized (no longer an exact "</details>" substring), even
  // though it still reads as "</details>" to a human once the invisible
  // character is stripped back out.
  const literalCloses = result.codeReview.markdown.match(/<\/details>/g) ?? [];
  assert.equal(
    literalCloses.length,
    chunkedBaseInput.chunks.length,
    `expected only our own wrapper closes in: ${result.codeReview.markdown}`,
  );
  assert.match(result.codeReview.markdown, /this file's own <.?\/details> tag usage/);
});

test("calls sandbox-test generation exactly once against the whole unchunked batch, regardless of chunk count", async () => {
  resetState();

  await runChunkedReviewPipeline(chunkedBaseInput);

  const sandboxCalls = calls.filter((c) => c.kind === "test-generator");
  assert.equal(sandboxCalls.length, 1);
  assert.match(sandboxCalls[0]!.userText, /full-batch-ctx/);
  assert.match(sandboxCalls[0]!.userText, /full-batch-diff/);
});

test("sizes each chunk's output token cap off that chunk's own file count, not the whole batch's", async () => {
  resetState();

  await runChunkedReviewPipeline({
    ...chunkedBaseInput,
    changedFiles: Array.from({ length: 20 }, (_, i) => `file${i}.ts`),
    chunks: [
      { label: "Chunk 1/2", changedFiles: ["only-one-file.ts"], astContext: "SMALL_CHUNK_CTX", diff: "d" },
      {
        label: "Chunk 2/2",
        changedFiles: Array.from({ length: 20 }, (_, i) => `file${i}.ts`),
        astContext: "BIG_CHUNK_CTX",
        diff: "d",
      },
    ],
  });

  const smallChunkCalls = calls.filter((c) => c.kind !== "test-generator" && c.userText.includes("SMALL_CHUNK_CTX"));
  const bigChunkCalls = calls.filter((c) => c.kind !== "test-generator" && c.userText.includes("BIG_CHUNK_CTX"));
  assert.equal(smallChunkCalls.length, 2, "expected code-review + security-audit for the small chunk");
  assert.equal(bigChunkCalls.length, 2, "expected code-review + security-audit for the big chunk");
  for (const call of smallChunkCalls) {
    assert.equal(call.maxOutputTokens, resolveMaxOutputTokens(1));
  }
  for (const call of bigChunkCalls) {
    assert.equal(call.maxOutputTokens, resolveMaxOutputTokens(20));
  }
  assert.ok(
    (bigChunkCalls[0]?.maxOutputTokens ?? 0) > (smallChunkCalls[0]?.maxOutputTokens ?? 0),
    "the 20-file chunk should get a larger cap than the 1-file chunk",
  );
});

test("processes chunks concurrently, bounded by MAX_CONCURRENT_CHUNKS, for a non-ollama provider", async () => {
  resetState();
  delaysMs = { "code-reviewer": 30, "security-auditor": 30 };
  const chunks = Array.from({ length: 7 }, (_, i) => ({
    label: `Chunk ${i + 1}/7`,
    changedFiles: [`file${i}.ts`],
    astContext: `CHUNK_${i}_CTX`,
    diff: "d",
  }));

  await runChunkedReviewPipeline({ ...chunkedBaseInput, chunks });

  assert.ok(maxObservedPersonaConcurrency > 1, "expected chunks to overlap in time, not run one at a time");
  assert.ok(
    maxObservedPersonaConcurrency <= MAX_CONCURRENT_CHUNKS,
    `expected peak concurrent persona calls (${maxObservedPersonaConcurrency}) to stay within MAX_CONCURRENT_CHUNKS (${MAX_CONCURRENT_CHUNKS})`,
  );
});

test("mapWithConcurrencyLimit stops dispatching new work once the signal is aborted, instead of draining every remaining item", async () => {
  const controller = new AbortController();
  const dispatched: number[] = [];
  const items = Array.from({ length: 30 }, (_, i) => i);

  const call = mapWithConcurrencyLimit(
    items,
    3,
    async (item, index) => {
      dispatched.push(index);
      if (index === 0) {
        // The first item to run fails, aborting the shared controller — but
        // not until 10ms in, giving the other two initial workers (indices 1
        // and 2) plenty of time to finish their own fast items and loop back
        // for more *before* the abort fires, exactly the scenario where a
        // pool without the abort check would keep dispatching new work.
        await new Promise((resolve) => setTimeout(resolve, 10));
        controller.abort(new Error("item 0 failed"));
        throw new Error("item 0 failed");
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
      return item;
    },
    controller.signal,
  );

  await assert.rejects(call, /item 0 failed/);
  // Give any worker that was already mid-item when the abort fired a moment
  // to loop back and (correctly) find nothing left to do, or (if the fix
  // regressed) keep dispatching further items despite the abort.
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.ok(
    dispatched.length < items.length,
    `expected the pool to stop well short of all ${items.length} items once aborted, dispatched: ${dispatched.length}`,
  );
  assert.equal(new Set(dispatched).size, dispatched.length, "no item should have been dispatched more than once");
});

test("processes chunks strictly sequentially for the ollama provider, to avoid contending with its single local model process (GH #22)", async () => {
  resetState();
  delaysMs = { "code-reviewer": 20, "security-auditor": 20 };
  const chunks = Array.from({ length: 4 }, (_, i) => ({
    label: `Chunk ${i + 1}/4`,
    changedFiles: [`file${i}.ts`],
    astContext: `CHUNK_${i}_CTX`,
    diff: "d",
  }));

  await runChunkedReviewPipeline({ ...chunkedBaseInput, provider: "ollama", chunks });

  assert.equal(
    maxObservedPersonaConcurrency,
    1,
    "expected at most one chunk's persona call in flight at a time for ollama",
  );
});

test("a chunk failure aborts the concurrently in-flight sandbox-test call instead of leaving it to run unobserved", async (t) => {
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
  await assert.rejects(
    runChunkedReviewPipeline({ ...chunkedBaseInput, chunks: [chunkedBaseInput.chunks[0]!] }),
    /code-reviewer failed/,
  );
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 1000, `expected the aborted sandbox-test call to settle quickly, took ${elapsed}ms`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    messages.some((m) => m.includes("sandbox-test failed") && m.includes("aborted")),
    `expected the aborted sandbox-test failure to be logged, got: ${JSON.stringify(messages)}`,
  );
});

test("a chunk failure stops the sequential (ollama) chunk loop from starting any remaining chunk", async () => {
  resetState();
  errorsAfterMs = { "code-reviewer": 5 };

  await assert.rejects(
    runChunkedReviewPipeline({ ...chunkedBaseInput, provider: "ollama" }),
    /code-reviewer failed/,
  );

  // Two chunks were configured; the sequential ollama loop should never have
  // attempted the second one once the first chunk's code-review call rejected.
  const codeReviewerCalls = calls.filter((c) => c.kind === "code-reviewer");
  assert.equal(codeReviewerCalls.length, 1, "the second chunk should never have started");
});

test("names the specific chunk in a truncation warning, via that chunk's own label", async (t) => {
  resetState();
  const messages: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.error = originalConsoleError;
  });

  await runChunkedReviewPipeline({
    ...chunkedBaseInput,
    chunks: [
      {
        label: "Chunk 1/1 (5 files) vs origin/main",
        changedFiles: ["a.ts"],
        astContext: "x".repeat(40_001),
        diff: "d",
      },
    ],
  });

  const truncationWarnings = messages.filter(
    (m) => m.includes("AST context") && m.includes("Chunk 1/1 (5 files) vs origin/main") && m.includes("truncated"),
  );
  assert.equal(truncationWarnings.length, 1, `expected the warning to name the chunk's own label, got: ${JSON.stringify(messages)}`);
});

// dedupeFindings (issue #46 step 5) — cross-chunk near-duplicate merging.

function finding(overrides: Partial<ReviewFinding>): ReviewFinding {
  return { file: "src/shared.ts", line: 10, severity: "Important", description: "placeholder", ...overrides };
}

test("dedupeFindings merges a genuine cross-chunk duplicate: same file/line, near-identically-worded description", () => {
  const a = finding({ description: "Missing a null check on `user` before it is dereferenced." });
  const b = finding({ description: "Missing a null check on `user` before it gets dereferenced." });

  const result = dedupeFindings([a, b]);

  assert.equal(result.length, 1, `expected the near-duplicate to be merged, got: ${JSON.stringify(result)}`);
  assert.deepEqual(result[0], a, "expected the first-seen finding to be kept");
});

test("dedupeFindings keeps distinct findings on the same file/line separate", () => {
  const a = finding({ description: "Missing a null check on `user` before it's dereferenced here." });
  const b = finding({ description: "This variable name shadows an outer-scope `config` and should be renamed." });

  const result = dedupeFindings([a, b]);

  assert.equal(result.length, 2, `expected genuinely different findings to both survive, got: ${JSON.stringify(result)}`);
});

test("dedupeFindings keeps identically-worded findings on different lines separate", () => {
  const a = finding({ line: 10, description: "Unhandled promise rejection here." });
  const b = finding({ line: 42, description: "Unhandled promise rejection here." });

  const result = dedupeFindings([a, b]);

  assert.equal(result.length, 2, "same wording on two different lines is two real findings, not one duplicate");
});

test("dedupeFindings keeps identically-worded findings on different files separate", () => {
  const a = finding({ file: "src/a.ts", description: "Unhandled promise rejection here." });
  const b = finding({ file: "src/b.ts", description: "Unhandled promise rejection here." });

  const result = dedupeFindings([a, b]);

  assert.equal(result.length, 2, "same wording in two different files is two real findings, not one duplicate");
});

test("dedupeFindings returns an empty array for an empty findings array", () => {
  assert.deepEqual(dedupeFindings([]), []);
});

test("dedupeFindings keeps a file-level finding (no line) and a line-anchored finding on the same file separate, even with identical wording", () => {
  const fileLevel = finding({ line: undefined, description: "Missing input validation somewhere in this file." });
  const lineAnchored = finding({ line: 10, description: "Missing input validation somewhere in this file." });

  const result = dedupeFindings([fileLevel, lineAnchored]);

  assert.equal(result.length, 2, "a file-level finding and a line-anchored finding are different scopes, not duplicates");
});

test("dedupeFindings normalizes case and punctuation before comparing, so two descriptions differing only in those still merge", () => {
  const a = finding({ description: "Missing a null check on `user` before it's dereferenced!" });
  const b = finding({ description: "MISSING A NULL CHECK ON `USER` BEFORE IT'S DEREFERENCED!" });

  const result = dedupeFindings([a, b]);

  assert.equal(result.length, 1, `expected case/punctuation-only variance to still merge, got: ${JSON.stringify(result)}`);
});

test("dedupeFindings is first-occurrence-wins, not transitive: A~B and B~C individually clear the threshold but A~C doesn't, so dropping B loses the link between A and C (documents accepted limitation, PR #52 review)", () => {
  // Word lists engineered so sim(A,B) ≈ 0.667 and sim(B,C) ≈ 0.667 — both
  // clear DEDUPE_SIMILARITY_THRESHOLD's 0.6 bar — while sim(A,C) ≈ 0.429 does
  // not. B is compared only against A (the sole bucket member when B is
  // processed) and dropped as A's duplicate; C is then compared only against
  // the still-just-A bucket (B, having been dropped, was never added to it),
  // so C survives even though it shares its strongest overlap with B, not A.
  const shared = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
  const a = finding({ description: [...shared, "golf", "hotel", "onlyA1", "onlyA2"].join(" ") });
  const b = finding({ description: [...shared, "golf", "hotel", "linkX", "linkY"].join(" ") });
  const c = finding({ description: [...shared, "linkX", "linkY", "onlyC1", "onlyC2"].join(" ") });

  const result = dedupeFindings([a, b, c]);

  assert.deepEqual(
    result.map((f) => f.description),
    [a.description, c.description],
    `expected B dropped as A's duplicate and C to survive, got: ${JSON.stringify(result.map((f) => f.description))}`,
  );
});

test("runChunkedReviewPipeline merges a cross-chunk duplicate finding in the aggregated codeReview.review.findings", async () => {
  resetState();
  customFindingsQueue["code-reviewer"] = [
    [finding({ file: "src/shared.ts", description: "SQL query concatenates user input directly into the query string." })],
    [finding({ file: "src/shared.ts", description: "SQL query concatenates user input directly." })],
  ];

  const result = await runChunkedReviewPipeline(chunkedBaseInput);

  assert.equal(
    result.codeReview.review.findings.length,
    1,
    `expected the two chunks' near-duplicate findings to merge into one, got: ${JSON.stringify(result.codeReview.review.findings)}`,
  );
});

// resolvedFindings (issue #55): a prior --pr run's already-addressed findings
// shouldn't be re-raised from scratch on every invocation.

test("injects a still-resolved finding as a 'don't re-flag' instruction into both persona prompts", async () => {
  resetState();

  await runReviewPipeline({
    ...baseInput,
    diff: "diff --git a/example.ts b/example.ts\n@@ -1,1 +1,1 @@\n unrelated line\n",
    resolvedFindings: [{ path: "example.ts", line: 42, body: "Missing null check on `user`." }],
  });

  const byKind = Object.fromEntries(calls.map((c) => [c.kind, c]));
  for (const kind of ["code-reviewer", "security-auditor"] as const) {
    assert.match(byKind[kind]!.systemText, /Previously Resolved Findings/);
    assert.match(byKind[kind]!.systemText, /example\.ts:42/);
    assert.match(byKind[kind]!.systemText, /Missing null check on `user`\./);
  }
  assert.doesNotMatch(byKind["test-generator"]!.systemText, /Previously Resolved Findings/);
});

test("omits the resolved-findings instruction entirely when resolvedFindings is absent", async () => {
  resetState();

  await runReviewPipeline(baseInput);

  const byKind = Object.fromEntries(calls.map((c) => [c.kind, c]));
  assert.doesNotMatch(byKind["code-reviewer"]!.systemText, /Previously Resolved Findings/);
  assert.doesNotMatch(byKind["security-auditor"]!.systemText, /Previously Resolved Findings/);
});

test("excludes a resolved finding from suppression once its exact file/line is touched again in the current diff (regression)", async () => {
  resetState();
  // New-side line numbers for this hunk: 10 (context "line10"), 11 (the
  // replaced "newline11" line), 12 (context "line12") — see parseDiffHunks.
  // Line 11 is the one this diff actually changed again.
  const regressedDiff = [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -10,3 +10,3 @@",
    " line10",
    "-oldline11",
    "+newline11",
    " line12",
    "",
  ].join("\n");

  await runReviewPipeline({
    ...baseInput,
    diff: regressedDiff,
    resolvedFindings: [{ path: "example.ts", line: 11, body: "Regressed finding." }],
  });

  const codeReviewCall = calls.find((c) => c.kind === "code-reviewer")!;
  assert.doesNotMatch(
    codeReviewCall.systemText,
    /Previously Resolved Findings/,
    "a regressed finding shouldn't produce a suppression instruction at all once it's the only one",
  );
});

test("keeps suppressing a resolved finding whose exact line the current diff doesn't touch", async () => {
  resetState();
  const untouchedDiff = [
    "diff --git a/example.ts b/example.ts",
    "--- a/example.ts",
    "+++ b/example.ts",
    "@@ -10,3 +10,3 @@",
    " line10",
    "-oldline11",
    "+newline11",
    " line12",
    "",
  ].join("\n");

  await runReviewPipeline({
    ...baseInput,
    diff: untouchedDiff,
    // Line 99 is nowhere in the hunk above, so this thread isn't regressed.
    resolvedFindings: [{ path: "example.ts", line: 99, body: "Should stay suppressed." }],
  });

  const codeReviewCall = calls.find((c) => c.kind === "code-reviewer")!;
  assert.match(codeReviewCall.systemText, /Previously Resolved Findings/);
  assert.match(codeReviewCall.systemText, /Should stay suppressed/);
});

test("keeps suppressing a resolved finding with no line (file-level) regardless of the diff", async () => {
  resetState();

  await runReviewPipeline({
    ...baseInput,
    resolvedFindings: [{ path: "example.ts", line: null, body: "File-level note." }],
  });

  const codeReviewCall = calls.find((c) => c.kind === "code-reviewer")!;
  assert.match(codeReviewCall.systemText, /Previously Resolved Findings/);
  assert.match(codeReviewCall.systemText, /\[example\.ts\] File-level note\./);
});

test("applies the same PR-wide resolvedFindings instruction to every chunk in runChunkedReviewPipeline, checked against the full batch diff", async () => {
  resetState();

  await runChunkedReviewPipeline({
    ...chunkedBaseInput,
    fullDiff: "diff --git a/unrelated.ts b/unrelated.ts\n@@ -1,1 +1,1 @@\n x\n",
    resolvedFindings: [{ path: "a.ts", line: 5, body: "Already fixed." }],
  });

  const codeReviewCalls = calls.filter((c) => c.kind === "code-reviewer");
  assert.equal(codeReviewCalls.length, 2, "expected one code-reviewer call per chunk");
  for (const call of codeReviewCalls) {
    assert.match(call.systemText, /Previously Resolved Findings/);
    assert.match(call.systemText, /Already fixed\./);
  }
});

// Cross-chunk severity downgrade (issue #55): a chunk can't see files outside
// its own file list, so a finding depending on one of those files is only a
// suspicion, not a confirmed defect.

test("tells each chunk's personas which batch files are outside its own context", async () => {
  resetState();

  await runChunkedReviewPipeline(chunkedBaseInput);

  const codeReviewCalls = calls.filter((c) => c.kind === "code-reviewer");
  assert.equal(codeReviewCalls.length, 2);
  assert.match(codeReviewCalls[0]!.systemText, /Cross-File Context \(chunk 1\/2\)/);
  assert.match(codeReviewCalls[0]!.systemText, /NOT in this call's context: b\.ts/);
  assert.match(codeReviewCalls[1]!.systemText, /Cross-File Context \(chunk 2\/2\)/);
  assert.match(codeReviewCalls[1]!.systemText, /NOT in this call's context: a\.ts/);
});

test("does not inject cross-file-context instructions in the unchunked pipeline (nothing is out of context)", async () => {
  resetState();

  await runReviewPipeline(baseInput);

  const codeReviewCall = calls.find((c) => c.kind === "code-reviewer")!;
  assert.doesNotMatch(codeReviewCall.systemText, /Cross-File Context/);
});

test("forces a chunk finding's severity down to Info once it's marked as needing cross-chunk follow-up, regardless of what severity the model assigned", async () => {
  resetState();
  customFindingsQueue["security-auditor"] = [
    [
      finding({
        file: "a.ts",
        severity: "Critical",
        description: "needs follow-up in chunk 1/2: cannot confirm without seeing b.ts",
      }),
    ],
    [finding({ file: "b.ts", severity: "Medium", description: "an unrelated, fully confirmed issue" })],
  ];

  const result = await runChunkedReviewPipeline(chunkedBaseInput);

  const capped = result.securityAudit.review.findings.find((f) => f.file === "a.ts");
  const uncapped = result.securityAudit.review.findings.find((f) => f.file === "b.ts");
  assert.equal(capped?.severity, "Info", `expected the follow-up-marked finding capped to Info, got: ${JSON.stringify(capped)}`);
  assert.equal(uncapped?.severity, "Medium", "an unrelated finding without the marker should keep its own severity");
  // The rendered markdown must reflect the same capped severity, not the
  // model's original (uncapped) choice — renderPersonaReviewMarkdown groups
  // findings by severity, so a stale severity there would silently reappear
  // under the wrong heading.
  assert.doesNotMatch(result.securityAudit.markdown, /### Critical/);
});

test("leaves a finding's severity untouched in the unchunked pipeline even if its description happens to contain the follow-up phrase", async () => {
  resetState();
  customFindingsQueue["code-reviewer"] = [
    [finding({ severity: "Critical", description: "needs follow-up in chunk 1/2: coincidental phrasing" })],
  ];

  const result = await runReviewPipeline(baseInput);

  assert.equal(result.codeReview.review.findings[0]?.severity, "Critical");
});

// Truncation notices (issue #55): a truncated AST/diff section should be
// visible to whoever reads the posted review, not just stderr.

test("returns a TruncationNotice in ReviewResult.truncations when the AST/diff section is truncated", async () => {
  resetState();

  const result = await runReviewPipeline({ ...baseInput, astContext: "x".repeat(40_001) });

  assert.equal(result.truncations.length, 1);
  assert.equal(result.truncations[0]?.section, "AST context");
  assert.equal(result.truncations[0]?.filePath, "example.ts");
  assert.equal(result.truncations[0]?.omittedChars, 1);
});

test("returns an empty truncations array when nothing was truncated", async () => {
  resetState();

  const result = await runReviewPipeline(baseInput);

  assert.deepEqual(result.truncations, []);
});

test("collects truncations across every chunk plus the full-batch sandbox-test call in runChunkedReviewPipeline", async () => {
  resetState();

  const result = await runChunkedReviewPipeline({
    ...chunkedBaseInput,
    chunks: [
      { ...chunkedBaseInput.chunks[0]!, astContext: "x".repeat(40_001) },
      { ...chunkedBaseInput.chunks[1]!, diff: "y".repeat(40_001) },
    ],
    fullAstContext: "z".repeat(40_001),
  });

  const sections = result.truncations.map((t) => t.section).sort();
  assert.deepEqual(sections, ["AST context", "AST context", "diff"]);
});
