import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getPrMetadata,
  getResolvedThreads,
  MAX_RESOLVED_THREAD_PAGES,
  parseGitHubRemote,
  postPrComment,
  postPrReview,
} from "./github-client.js";

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

test("postPrReview sends the expected request, defaults to a COMMENT event, and returns the review URL", async (t) => {
  const originalFetch = global.fetch;
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;

  global.fetch = (async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({ html_url: "https://github.com/o/r/pull/1#pullrequestreview-1" }),
    } as Response;
  }) as typeof fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const comments = [{ path: "src/foo.ts", line: 3, body: "consider renaming this" }];
  const result = await postPrReview({
    owner: "o",
    repo: "r",
    pr: 1,
    body: "cover note",
    comments,
    token: "tok",
  });

  assert.equal(capturedUrl, "https://api.github.com/repos/o/r/pulls/1/reviews");
  assert.equal(capturedInit?.method, "POST");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tok");
  assert.equal(headers.Accept, "application/vnd.github+json");
  const sentBody = JSON.parse(capturedInit?.body as string);
  assert.equal(sentBody.body, "cover note");
  assert.equal(sentBody.event, "COMMENT");
  assert.deepEqual(sentBody.comments, comments);
  assert.deepEqual(result, { url: "https://github.com/o/r/pull/1#pullrequestreview-1" });
});

test("postPrReview passes through an explicit event override", async (t) => {
  const originalFetch = global.fetch;
  let capturedInit: RequestInit | undefined;

  global.fetch = (async (_url: string, init: RequestInit) => {
    capturedInit = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({ html_url: "https://github.com/o/r/pull/1#pullrequestreview-2" }),
    } as Response;
  }) as typeof fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  await postPrReview({
    owner: "o",
    repo: "r",
    pr: 1,
    body: "looks good",
    comments: [],
    token: "tok",
    event: "APPROVE",
  });

  assert.equal(JSON.parse(capturedInit?.body as string).event, "APPROVE");
});

test("postPrReview truncates an oversized comment body instead of letting one finding fail the whole review", async (t) => {
  const originalFetch = global.fetch;
  let capturedInit: RequestInit | undefined;

  global.fetch = (async (_url: string, init: RequestInit) => {
    capturedInit = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({ html_url: "https://github.com/o/r/pull/1#pullrequestreview-3" }),
    } as Response;
  }) as typeof fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const oversizedBody = "x".repeat(70_000);
  await postPrReview({
    owner: "o",
    repo: "r",
    pr: 1,
    body: "cover note",
    comments: [{ path: "src/foo.ts", line: 1, body: oversizedBody }],
    token: "tok",
  });

  const sentComments = JSON.parse(capturedInit?.body as string).comments as { body: string }[];
  assert.ok(sentComments[0]);
  assert.ok(sentComments[0].body.length <= 65_536);
  assert.match(sentComments[0].body, /…\(truncated\)$/);
});

test("postPrReview throws with response detail on a non-ok response", async (t) => {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    ({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      text: async () => '{"message":"line must be part of the diff"}',
    }) as Response) as typeof fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(
    postPrReview({ owner: "o", repo: "r", pr: 999, body: "x", comments: [], token: "tok" }),
    /HTTP 422.*line must be part of the diff/,
  );
});

test("getPrMetadata sends a GET to the PR endpoint and returns its title/body", async (t) => {
  const originalFetch = global.fetch;
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;

  global.fetch = (async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({ title: "Add dark mode toggle", body: "## What\nAdds a toggle.\n" }),
    } as Response;
  }) as typeof fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await getPrMetadata("o", "r", 42, "tok");

  assert.equal(capturedUrl, "https://api.github.com/repos/o/r/pulls/42");
  assert.equal(capturedInit?.method, undefined);
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tok");
  assert.deepEqual(result, { title: "Add dark mode toggle", body: "## What\nAdds a toggle.\n" });
});

test("getPrMetadata treats a null body as an empty string", async (t) => {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ title: "No description PR", body: null }),
    }) as Response) as typeof fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await getPrMetadata("o", "r", 1, "tok");
  assert.deepEqual(result, { title: "No description PR", body: "" });
});

test("getPrMetadata throws with response detail on a non-ok response", async (t) => {
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

  await assert.rejects(getPrMetadata("o", "r", 999, "tok"), /HTTP 404.*Not Found/);
});

function reviewThreadsPage(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes },
        },
      },
    },
  };
}

test("getResolvedThreads posts a GraphQL query and returns only resolved threads", async (t) => {
  const originalFetch = global.fetch;
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;

  global.fetch = (async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return {
      ok: true,
      status: 200,
      json: async () =>
        reviewThreadsPage([
          { isResolved: true, path: "src/foo.ts", line: 12, comments: { nodes: [{ body: "fix this" }] } },
          { isResolved: false, path: "src/bar.ts", line: 3, comments: { nodes: [{ body: "still open" }] } },
        ]),
    } as Response;
  }) as typeof fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await getResolvedThreads("o", "r", 1, "tok");

  assert.equal(capturedUrl, "https://api.github.com/graphql");
  assert.equal(capturedInit?.method, "POST");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer tok");
  const sentBody = JSON.parse(capturedInit?.body as string);
  assert.match(sentBody.query, /reviewThreads/);
  assert.deepEqual(sentBody.variables, { owner: "o", repo: "r", pr: 1, after: null });
  assert.ok(capturedInit?.signal instanceof AbortSignal, "expected the request to be bounded by a timeout signal");

  assert.deepEqual(result, [{ path: "src/foo.ts", line: 12, body: "fix this" }]);
});

test("getResolvedThreads gives up after MAX_RESOLVED_THREAD_PAGES instead of looping forever on a misbehaving response", async (t) => {
  const originalFetch = global.fetch;
  let fetchCount = 0;

  global.fetch = (async () => {
    fetchCount++;
    return {
      ok: true,
      status: 200,
      json: async () =>
        // Always reports another page, with no resolved threads to make progress on.
        reviewThreadsPage([], true, "same-cursor"),
    } as Response;
  }) as typeof fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(getResolvedThreads("o", "r", 1, "tok"), /exceeded \d+ pages/);
  assert.equal(fetchCount, MAX_RESOLVED_THREAD_PAGES);
});

test("getResolvedThreads paginates across multiple pages until hasNextPage is false", async (t) => {
  const originalFetch = global.fetch;
  const capturedAfters: (string | null)[] = [];

  global.fetch = (async (_url: string, init: RequestInit) => {
    const variables = JSON.parse(init.body as string).variables as { after: string | null };
    capturedAfters.push(variables.after);
    if (variables.after === null) {
      return {
        ok: true,
        status: 200,
        json: async () =>
          reviewThreadsPage(
            [{ isResolved: true, path: "src/a.ts", line: 1, comments: { nodes: [{ body: "page 1" }] } }],
            true,
            "cursor-1",
          ),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () =>
        reviewThreadsPage([{ isResolved: true, path: "src/b.ts", line: 2, comments: { nodes: [{ body: "page 2" }] } }]),
    } as Response;
  }) as typeof fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await getResolvedThreads("o", "r", 1, "tok");

  assert.deepEqual(capturedAfters, [null, "cursor-1"]);
  assert.deepEqual(result, [
    { path: "src/a.ts", line: 1, body: "page 1" },
    { path: "src/b.ts", line: 2, body: "page 2" },
  ]);
});

test("getResolvedThreads keeps a file-level (line: null) resolved thread", async (t) => {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () =>
        reviewThreadsPage([
          { isResolved: true, path: "src/foo.ts", line: null, comments: { nodes: [{ body: "file-level note" }] } },
        ]),
    }) as unknown as Response) as typeof fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await getResolvedThreads("o", "r", 1, "tok");

  assert.deepEqual(result, [{ path: "src/foo.ts", line: null, body: "file-level note" }]);
});

test("getResolvedThreads skips a resolved thread with no comment body", async (t) => {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => reviewThreadsPage([{ isResolved: true, path: "src/foo.ts", line: 1, comments: { nodes: [] } }]),
    }) as unknown as Response) as typeof fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await getResolvedThreads("o", "r", 1, "tok");

  assert.deepEqual(result, []);
});

test("getResolvedThreads throws with response detail on a non-ok response", async (t) => {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => '{"message":"Bad credentials"}',
    }) as Response) as typeof fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(getResolvedThreads("o", "r", 1, "tok"), /HTTP 401.*Bad credentials/);
});

test("getResolvedThreads throws when the GraphQL response carries an errors array", async (t) => {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ errors: [{ message: "Could not resolve to a PullRequest" }] }),
    }) as Response) as typeof fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(getResolvedThreads("o", "r", 999, "tok"), /Could not resolve to a PullRequest/);
});
