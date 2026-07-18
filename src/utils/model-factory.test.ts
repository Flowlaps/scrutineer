import { test } from "node:test";
import assert from "node:assert/strict";
import { createModel } from "./model-factory.js";

function modelId(model: Awaited<ReturnType<typeof createModel>>): string {
  return (model as { modelId: string }).modelId;
}

function configuredUrl(model: Awaited<ReturnType<typeof createModel>>, path: string): string {
  const config = (model as unknown as { config: { url: (opts: { path: string }) => string } })
    .config;
  return config.url({ path });
}

function withMockFetch(t: import("node:test").TestContext, impl: typeof fetch) {
  const original = global.fetch;
  global.fetch = impl;
  t.after(() => {
    global.fetch = original;
  });
}

function withMockConsoleError(t: import("node:test").TestContext): string[] {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map(String).join(" "));
  };
  t.after(() => {
    console.error = original;
  });
  return messages;
}

function withEnv(t: import("node:test").TestContext, key: string, value: string | undefined) {
  const original = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
  t.after(() => {
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  });
}

test("createModel(anthropic) uses the default model ID with no override", async (t) => {
  withEnv(t, "SCRUTINEER_MODEL_ANTHROPIC", undefined);
  const model = await createModel("anthropic");
  assert.equal(modelId(model), "claude-sonnet-5");
});

test("createModel(anthropic) respects SCRUTINEER_MODEL_ANTHROPIC", async (t) => {
  withEnv(t, "SCRUTINEER_MODEL_ANTHROPIC", "claude-opus-4-8");
  const model = await createModel("anthropic");
  assert.equal(modelId(model), "claude-opus-4-8");
});

test("createModel(ollama) respects SCRUTINEER_MODEL_OLLAMA without querying Ollama", async (t) => {
  withEnv(t, "SCRUTINEER_MODEL_OLLAMA", "phi4");
  withMockFetch(t, (async () => {
    throw new Error("fetch should not be called when an override is set");
  }) as typeof fetch);

  const model = await createModel("ollama");
  assert.equal(modelId(model), "phi4");
});

test("createModel(ollama) still targets OLLAMA_HOST when SCRUTINEER_MODEL_OLLAMA skips detection", async (t) => {
  withEnv(t, "SCRUTINEER_MODEL_OLLAMA", "phi4");
  withEnv(t, "OLLAMA_HOST", "http://172.27.96.1:11434");
  withMockFetch(t, (async () => {
    throw new Error("fetch should not be called when an override is set");
  }) as typeof fetch);

  const model = await createModel("ollama");
  assert.equal(modelId(model), "phi4");
  assert.equal(configuredUrl(model, "/chat"), "http://172.27.96.1:11434/api/chat");
});

test("createModel(ollama) uses the currently running model from /api/ps", async (t) => {
  withEnv(t, "SCRUTINEER_MODEL_OLLAMA", undefined);
  withMockFetch(t, (async (url: string) => {
    assert.match(url, /\/api\/ps$/);
    return {
      ok: true,
      json: async () => ({ models: [{ model: "phi4:14b" }] }),
    } as Response;
  }) as typeof fetch);

  const model = await createModel("ollama");
  assert.equal(modelId(model), "phi4:14b");
});

test("createModel(ollama) falls back to /api/tags when nothing is running", async (t) => {
  withEnv(t, "SCRUTINEER_MODEL_OLLAMA", undefined);
  withMockFetch(t, (async (url: string) => {
    if (url.endsWith("/api/ps")) {
      return { ok: true, json: async () => ({ models: [] }) } as Response;
    }
    assert.match(url, /\/api\/tags$/);
    return {
      ok: true,
      json: async () => ({ models: [{ name: "llama3.1:8b" }] }),
    } as Response;
  }) as typeof fetch);

  const model = await createModel("ollama");
  assert.equal(modelId(model), "llama3.1:8b");
});

test("createModel(ollama) falls back to the hardcoded default when Ollama is unreachable", async (t) => {
  withEnv(t, "SCRUTINEER_MODEL_OLLAMA", undefined);
  withMockFetch(t, (async () => {
    throw new Error("connection refused");
  }) as typeof fetch);

  const model = await createModel("ollama");
  assert.equal(modelId(model), "phi4");
});

test("createModel(ollama) queries OLLAMA_HOST instead of the 127.0.0.1 default when set", async (t) => {
  withEnv(t, "SCRUTINEER_MODEL_OLLAMA", undefined);
  withEnv(t, "OLLAMA_HOST", "http://172.27.96.1:11434");
  const requestedUrls: string[] = [];
  withMockFetch(t, (async (url: string) => {
    requestedUrls.push(url);
    return {
      ok: true,
      json: async () => ({ models: [{ model: "phi4:latest" }] }),
    } as Response;
  }) as typeof fetch);

  const model = await createModel("ollama");
  assert.equal(modelId(model), "phi4:latest");
  assert.equal(requestedUrls[0], "http://172.27.96.1:11434/api/ps");
});

test("createModel(ollama) normalizes a bare host:port OLLAMA_HOST (no scheme, trailing slash)", async (t) => {
  withEnv(t, "SCRUTINEER_MODEL_OLLAMA", undefined);
  withEnv(t, "OLLAMA_HOST", "172.27.96.1:11434/");
  const requestedUrls: string[] = [];
  withMockFetch(t, (async (url: string) => {
    requestedUrls.push(url);
    return { ok: true, json: async () => ({ models: [] }) } as Response;
  }) as typeof fetch);

  await createModel("ollama");
  assert.equal(requestedUrls[0], "http://172.27.96.1:11434/api/ps");
});

test("createModel(ollama) warns on stderr when OLLAMA_HOST redirects review content off the local default", async (t) => {
  withEnv(t, "SCRUTINEER_MODEL_OLLAMA", undefined);
  withEnv(t, "OLLAMA_HOST", "http://172.27.96.1:11434");
  const messages = withMockConsoleError(t);
  withMockFetch(t, (async () => {
    return { ok: true, json: async () => ({ models: [] }) } as Response;
  }) as typeof fetch);

  await createModel("ollama");
  assert.ok(
    messages.some((m) => m.includes("172.27.96.1:11434") && m.includes("OLLAMA_HOST")),
    `expected a warning mentioning OLLAMA_HOST and the redirected host, got: ${JSON.stringify(messages)}`,
  );
});

test("createModel(ollama) does not warn for semantically-local OLLAMA_HOST values (localhost, ::1)", async (t) => {
  withEnv(t, "SCRUTINEER_MODEL_OLLAMA", undefined);
  const messages = withMockConsoleError(t);
  withMockFetch(t, (async () => {
    return { ok: true, json: async () => ({ models: [] }) } as Response;
  }) as typeof fetch);

  withEnv(t, "OLLAMA_HOST", "localhost:11434");
  await createModel("ollama");
  withEnv(t, "OLLAMA_HOST", "http://[::1]:11434");
  await createModel("ollama");

  assert.equal(messages.length, 0);
});

test("createModel(ollama) does not warn when OLLAMA_HOST is unset (local default)", async (t) => {
  withEnv(t, "SCRUTINEER_MODEL_OLLAMA", undefined);
  withEnv(t, "OLLAMA_HOST", undefined);
  const messages = withMockConsoleError(t);
  withMockFetch(t, (async () => {
    return { ok: true, json: async () => ({ models: [] }) } as Response;
  }) as typeof fetch);

  await createModel("ollama");
  assert.equal(messages.length, 0);
});
