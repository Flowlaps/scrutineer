import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGitHubRemote, postPrComment } from "./github-client.js";

test("parses an SSH remote URL", () => {
  assert.deepEqual(parseGitHubRemote("git@github.com:dallaskoncir/scrutineer.git"), {
    owner: "dallaskoncir",
    repo: "scrutineer",
  });
});

test("parses an HTTPS remote URL", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/dallaskoncir/scrutineer.git"), {
    owner: "dallaskoncir",
    repo: "scrutineer",
  });
});

test("parses an HTTPS remote URL without the .git suffix", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/dallaskoncir/scrutineer"), {
    owner: "dallaskoncir",
    repo: "scrutineer",
  });
});

test("returns undefined for a non-GitHub remote", () => {
  assert.equal(parseGitHubRemote("git@gitlab.com:someone/somewhere.git"), undefined);
});

test("postPrComment sends the expected request and returns the comment URL", async (t) => {
  const originalFetch = global.fetch;
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;

  global.fetch = (async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return {
      ok: true,
      status: 201,
      json: async () => ({ html_url: "https://github.com/o/r/pull/1#issuecomment-1" }),
    } as Response;
  }) as typeof fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await postPrComment({
    owner: "o",
    repo: "r",
    pr: 1,
    body: "hello",
    token: "tok",
  });

  assert.equal(capturedUrl, "https://api.github.com/repos/o/r/issues/1/comments");
  assert.equal(capturedInit?.method, "POST");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tok");
  assert.equal(headers.Accept, "application/vnd.github+json");
  assert.equal(JSON.parse(capturedInit?.body as string).body, "hello");
  assert.deepEqual(result, { url: "https://github.com/o/r/pull/1#issuecomment-1" });
});

test("postPrComment throws with response detail on a non-ok response", async (t) => {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => '{"message":"Not Found"}',
    }) as Response) as typeof fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(
    postPrComment({ owner: "o", repo: "r", pr: 999, body: "x", token: "tok" }),
    /HTTP 404.*Not Found/,
  );
});
