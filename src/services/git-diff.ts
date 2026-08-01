import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { scrubSecrets } from "./secret-scrubber.js";
import { isDynamicSkillTrigger, isLockfileFile } from "./skill-router.js";

const CHANGED_FILE_EXTENSIONS = [".ts", ".tsx"];

// Node's execFileSync defaults maxBuffer to 1MB. getDiffAgainstTarget's
// content-diff call now runs unrestricted (no `-- <pathspec>`, see
// filterDiffToFiles below) to keep git's rename pairing intact, which means
// it buffers the *whole* target...HEAD diff — not just the files under
// review — before filtering. A generous but bounded cap avoids both a
// pathological OOM and the default 1MB limit throwing on an entirely
// ordinary diff (e.g. a small code change alongside an unrelated large
// lockfile update in the same commit range — PR #65 review).
const GIT_DIFF_MAX_BUFFER_BYTES = 100 * 1024 * 1024;

function runGitDiff(args: string[], cwd?: string): string {
  return execFileSync("git", args, { encoding: "utf-8", cwd, maxBuffer: GIT_DIFF_MAX_BUFFER_BYTES });
}

// Shared by getChangedFiles and getDiffAgainstTarget so a git failure —
// unreachable ref, or a diff too large even for GIT_DIFF_MAX_BUFFER_BYTES
// (ENOBUFS) — surfaces as one clear message instead of a raw
// Node/child_process error string (CLAUDE.md's Phase 9: "a clear,
// user-friendly error message, not a raw stack trace").
function friendlyDiffError(target: string, error: unknown): Error {
  const stderr =
    error && typeof error === "object" && "stderr" in error ? String(error.stderr).trim() : "";
  return new Error(
    `scrutineer: could not diff against "${target}" — make sure it's a valid, reachable git ref ` +
      `(branch, tag, or commit), e.g. --diff origin/main.` +
      (stderr ? `\n${stderr}` : ""),
    { cause: error },
  );
}

const DIFF_GIT_HEADER_PATTERN = /^diff --git a\/.+ b\/(.+)$/;

// Restricting `git diff` to a `-- <pathspec>` of only the new-side paths (as
// this used to do) defeats git's rename pairing: with the old path excluded
// from the pathspec, git can't match it against the new one and reports a
// rename+edit as a 100%-new file, which corrupts hunk-line validation for
// GitHub's Reviews API (issue #63). Running the diff unrestricted keeps
// rename detection intact (matching what GitHub's own PR view sees), so
// filtering is done afterward on the diff text instead of via pathspec.
function filterDiffToFiles(diffText: string, filePaths: string[]): string {
  const wanted = new Set(filePaths);
  const blocks: string[] = [];
  let current: string[] = [];
  let currentWanted = false;

  const flush = () => {
    if (currentWanted && current.length > 0) {
      blocks.push(current.join("\n"));
    }
  };

  for (const line of diffText.split("\n")) {
    const headerMatch = line.match(DIFF_GIT_HEADER_PATTERN);
    if (headerMatch) {
      flush();
      current = [];
      currentWanted = wanted.has(headerMatch[1] ?? "");
    }
    current.push(line);
  }
  flush();

  return blocks.join("\n");
}

function withSecretsScrubbed(content: string): string {
  const { scrubbed, redactedCount } = scrubSecrets(content);
  if (redactedCount > 0) {
    console.error(
      `scrutineer: redacted ${redactedCount} value(s) that looked like secrets before sending to the review model`,
    );
  }
  return scrubbed;
}

// Ref is passed as an argv element via execFileSync (never through a shell), so a
// hostile or malformed --diff target can't inject shell commands. It can still
// inject a git *argument*, though: a target starting with "-" (e.g.
// "--output=/some/path") gets parsed by git as a flag rather than as part of the
// revision range, since it lands in the same argv token as "...HEAD". No legitimate
// git ref starts with "-", so reject that up front instead of handing it to git.
function assertSafeRefTarget(target: string): void {
  if (target.startsWith("-")) {
    throw new Error(
      `scrutineer: "${target}" is not a valid git ref for --diff — refs can't start with "-". ` +
        "Pass a branch, tag, or commit, e.g. --diff origin/main.",
    );
  }
}

export function getChangedFiles(target: string, cwd?: string): string[] {
  assertSafeRefTarget(target);
  let output: string;
  try {
    output = runGitDiff(["diff", "--name-only", `${target}...HEAD`], cwd);
  } catch (error) {
    throw friendlyDiffError(target, error);
  }
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        (CHANGED_FILE_EXTENSIONS.some((ext) => line.endsWith(ext)) || isDynamicSkillTrigger(line)),
    );
}

// Lockfiles are generated and often huge — a --diff batch that includes one
// concatenates its full diff body into the same string as every other changed
// file, ahead of ai-orchestrator.ts's fixed MAX_SECTION_CHARS truncation, which
// can push the actual .ts/.tsx changes in the batch out of what the model ever
// sees (issue #31). Lockfile content isn't meant to be reviewed line-by-line
// anyway, so their diff body is replaced with a `--stat` summary (still enough
// to see the change happened and roughly how large it was) instead of being
// dropped outright — dropping it silently would reintroduce the "no lockfile
// update" false positive issue #27 fixed, since a lockfile with zero visible
// change in the diff looks identical to one that never changed at all.
export function getDiffAgainstTarget(target: string, filePaths: string[], cwd?: string): string {
  assertSafeRefTarget(target);
  const lockfiles = filePaths.filter(isLockfileFile);
  const contentFiles = filePaths.filter((f) => !isLockfileFile(f));

  const parts: string[] = [];
  try {
    if (contentFiles.length > 0) {
      const fullDiff = runGitDiff(["diff", "--no-color", `${target}...HEAD`], cwd);
      parts.push(filterDiffToFiles(fullDiff, contentFiles));
    }
    if (lockfiles.length > 0) {
      const stat = runGitDiff(
        ["diff", "--no-color", "--stat", `${target}...HEAD`, "--", ...lockfiles],
        cwd,
      );
      parts.push(
        "# Lockfile changes (content omitted from review — generated files; only the " +
          "fact that they changed and how much is shown, so a paired package.json " +
          "update isn't flagged as missing):\n" +
          stat,
      );
    }
  } catch (error) {
    throw friendlyDiffError(target, error);
  }
  return withSecretsScrubbed(parts.join("\n\n"));
}

export function getFileDiff(filePath: string): string {
  try {
    const workingTreeDiff = runGitDiff(["diff", "--no-color", "--", filePath]);
    if (workingTreeDiff.trim().length > 0) {
      return withSecretsScrubbed(workingTreeDiff);
    }

    const stagedDiff = runGitDiff(["diff", "--no-color", "--cached", "--", filePath]);
    if (stagedDiff.trim().length > 0) {
      return withSecretsScrubbed(stagedDiff);
    }
  } catch {
    // Not a git repo, git unavailable, or the file isn't tracked — fall through.
  }

  const fileContents = readFileSync(filePath, "utf-8");
  return withSecretsScrubbed(
    `(no uncommitted changes detected; showing full file contents)\n\n${fileContents}`,
  );
}
