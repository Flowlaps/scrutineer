import { execFileSync } from "node:child_process";

export interface RepoSlug {
  owner: string;
  repo: string;
}

/**
 * Parses `owner/repo` out of a GitHub remote URL, supporting both SSH
 * (`git@github.com:owner/repo.git`) and HTTPS
 * (`https://github.com/owner/repo.git`) forms, with or without the `.git`
 * suffix. Exported (not just used internally) so the parsing logic is
 * testable without shelling out to git.
 */
export function parseGitHubRemote(url: string): RepoSlug | undefined {
  const match = url.trim().match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!match) {
    return undefined;
  }
  const [, owner, repo] = match;
  return owner && repo ? { owner, repo } : undefined;
}

/**
 * Reads the `origin` remote via `git remote get-url` and parses it into
 * `owner/repo`.
 */
export function getRepoSlugFromGit(): RepoSlug | undefined {
  let url: string;
  try {
    url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8" });
  } catch {
    return undefined;
  }
  return parseGitHubRemote(url);
}

/** Shared result shape for both write operations below — each just wraps the created object's `html_url`. */
export interface GitHubPostResult {
  url: string;
}

export type PostPrCommentResult = GitHubPostResult;
export type PostPrReviewResult = GitHubPostResult;

/**
 * Shared POST + error-handling logic for both `postPrComment()` and
 * `postPrReview()` (PR #50 review) — same headers, same fetch, same
 * "throw with GitHub's response detail on non-ok" pattern either way, just a
 * different URL/payload/error label. Keeps the two error message strings
 * from being able to drift independently.
 */
async function postToGitHub<T>(url: string, token: string, payload: unknown, operation: string): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to ${operation} (HTTP ${response.status}): ${detail || response.statusText}`);
  }

  return (await response.json()) as T;
}

export interface PostPrCommentOptions {
  owner: string;
  repo: string;
  pr: number;
  body: string;
  token: string;
}

export async function postPrComment(options: PostPrCommentOptions): Promise<PostPrCommentResult> {
  const { owner, repo, pr, body, token } = options;
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${pr}/comments`;

  const json = await postToGitHub<{ html_url: string }>(url, token, { body }, "post PR comment");
  return { url: json.html_url };
}

export interface PrReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface PostPrReviewOptions {
  owner: string;
  repo: string;
  pr: number;
  body: string;
  comments: PrReviewComment[];
  token: string;
  /**
   * Scrutineer is advisory, not a gatekeeper — it should never auto-approve
   * or auto-block a PR on the user's behalf, so this defaults to "COMMENT"
   * rather than "APPROVE"/"REQUEST_CHANGES".
   */
  event?: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
}

// GitHub's own review/issue comment body limit is 65536 characters; the
// Reviews API is a single all-or-nothing POST, so one oversized comment
// (e.g. a persona hallucinating a very long finding) would otherwise fail
// the whole review and silently drop every other, valid finding along with
// it (PR #50 review). Truncating client-side lets the rest of the batch
// still land.
const MAX_COMMENT_BODY_LENGTH = 65536;
const TRUNCATION_SUFFIX = "\n\n…(truncated)";

function truncateCommentBody(body: string): string {
  if (body.length <= MAX_COMMENT_BODY_LENGTH) {
    return body;
  }
  return body.slice(0, MAX_COMMENT_BODY_LENGTH - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

/**
 * Posts a native GitHub review (`POST .../pulls/{pr}/reviews`) with a
 * top-level summary `body` plus per-line `comments`, instead of
 * `postPrComment()`'s single flat issue comment (issue #46).
 */
export async function postPrReview(options: PostPrReviewOptions): Promise<PostPrReviewResult> {
  const { owner, repo, pr, body, comments, token, event = "COMMENT" } = options;
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${pr}/reviews`;

  const boundedComments = comments.map((comment) => ({ ...comment, body: truncateCommentBody(comment.body) }));
  const json = await postToGitHub<{ html_url: string }>(
    url,
    token,
    { body, event, comments: boundedComments },
    "post PR review",
  );
  return { url: json.html_url };
}

// A prior finding's home on a resolved thread: the file/line it was anchored
// to (both nullable — a thread can be file-level, or the line it anchored to
// can have since been deleted from the diff) plus its first comment's body,
// used as the finding's identity for suppression (issue #55).
export interface ResolvedThreadSummary {
  path: string;
  line: number | null;
  body: string;
}

const RESOLVED_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $pr: Int!, $after: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved
            path
            line
            comments(first: 1) {
              nodes { body }
            }
          }
        }
      }
    }
  }
`;

interface ReviewThreadNode {
  isResolved: boolean;
  path: string;
  line: number | null;
  comments: { nodes: { body: string }[] };
}

interface ReviewThreadsResponse {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: ReviewThreadNode[];
        };
      };
    };
  };
  errors?: { message: string }[];
}

/**
 * Fetches every *resolved* review thread on a PR via the GraphQL API — the
 * REST Reviews API has no `isResolved` field, only the GraphQL
 * `PullRequestReviewThread` type does (issue #55). Used to suppress
 * re-raising a finding that was already addressed and resolved on a prior
 * `scrutineer review --pr` run against the same PR.
 */
export async function getResolvedThreads(
  owner: string,
  repo: string,
  pr: number,
  token: string,
): Promise<ResolvedThreadSummary[]> {
  const results: ResolvedThreadSummary[] = [];
  let after: string | null = null;

  do {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: RESOLVED_THREADS_QUERY, variables: { owner, repo, pr, after } }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Failed to fetch resolved review threads (HTTP ${response.status}): ${detail || response.statusText}`);
    }

    const json = (await response.json()) as ReviewThreadsResponse;
    if (json.errors && json.errors.length > 0) {
      throw new Error(`Failed to fetch resolved review threads: ${json.errors.map((e) => e.message).join("; ")}`);
    }

    const reviewThreads = json.data?.repository?.pullRequest?.reviewThreads;
    if (!reviewThreads) {
      break;
    }

    for (const node of reviewThreads.nodes) {
      if (!node.isResolved) {
        continue;
      }
      const body = node.comments.nodes[0]?.body;
      if (body) {
        results.push({ path: node.path, line: node.line, body });
      }
    }

    after = reviewThreads.pageInfo.hasNextPage ? reviewThreads.pageInfo.endCursor : null;
  } while (after);

  return results;
}
