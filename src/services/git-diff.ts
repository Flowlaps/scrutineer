import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { scrubSecrets } from "./secret-scrubber.js";

function runGitDiff(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf-8" });
}

function withSecretsScrubbed(content: string): string {
  const { scrubbed, redactedCount } = scrubSecrets(content);
  if (redactedCount > 0) {
    console.error(
      `slipstream: redacted ${redactedCount} value(s) that looked like secrets before sending to the review model`,
    );
  }
  return scrubbed;
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
