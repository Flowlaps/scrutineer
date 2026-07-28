import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDiffHunks, resolveInlineLocation } from "./diff-hunks.js";

const MULTI_HUNK_DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index abc123..def456 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,4 +1,5 @@",
  " line1",
  "-line2 old",
  "+line2 new",
  "+line2.5 new",
  " line3",
  " line4",
  "@@ -10,3 +11,4 @@",
  " line10",
  "+line10.5 new",
  " line11",
  " line12",
  "",
].join("\n");

test("parses added and context lines from a single hunk into the new-side line set, but not removed lines", () => {
  const singleHunk = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,3 +1,3 @@",
    " kept",
    "-removed",
    "+added",
    " kept2",
    "",
  ].join("\n");

  const hunks = parseDiffHunks(singleHunk);
  assert.deepEqual(Array.from(hunks.get("a.ts") ?? []).sort((a, b) => a - b), [1, 2, 3]);
});

test("tracks each hunk's own new-side line range separately across multiple hunks in the same file", () => {
  const hunks = parseDiffHunks(MULTI_HUNK_DIFF);
  const lines = Array.from(hunks.get("src/foo.ts") ?? []).sort((a, b) => a - b);

  // First hunk: new lines 1-5. Second hunk: new lines 11-14. Nothing in
  // between (6-10) is part of the diff at all.
  assert.deepEqual(lines, [1, 2, 3, 4, 5, 11, 12, 13, 14]);
});

test("a line number outside every hunk fails validation, even if it falls between two valid hunks", () => {
  const hunks = parseDiffHunks(MULTI_HUNK_DIFF);
  const validLines = hunks.get("src/foo.ts") ?? new Set();

  assert.equal(validLines.has(7), false);
  assert.equal(validLines.has(100), false);
});

test("parses the omitted-count hunk header form (`@@ -1 +1 @@`, no comma), a single-line hunk", () => {
  const singleLineHunk = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1 @@", "-old", "+new", ""].join(
    "\n",
  );

  const hunks = parseDiffHunks(singleLineHunk);
  assert.deepEqual(Array.from(hunks.get("a.ts") ?? []).sort((a, b) => a - b), [1]);
});

test("scopes line numbers per file, so one file's valid lines don't leak into another", () => {
  const twoFileDiff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,1 +1,2 @@",
    " line1",
    "+line2",
    "diff --git a/b.ts b/b.ts",
    "--- a/b.ts",
    "+++ b/b.ts",
    "@@ -5,1 +5,1 @@",
    " line5",
    "",
  ].join("\n");

  const hunks = parseDiffHunks(twoFileDiff);
  assert.deepEqual(Array.from(hunks.get("a.ts") ?? []).sort((a, b) => a - b), [1, 2]);
  assert.deepEqual(Array.from(hunks.get("b.ts") ?? []).sort((a, b) => a - b), [5]);
  assert.equal(hunks.get("a.ts")?.has(5), false);
});

test("doesn't mistake an added source line starting with '++ ' for a file-header line (PR #49 review)", () => {
  // The diffed form of an added line whose *content* is "++ x;" is literally
  // "+++ x;" (one "+" from the diff marker, two from the source text) —
  // indistinguishable from a real "+++ b/path" file header by regex alone
  // unless it's also checked for being preceded by a "--- " line, which a
  // mid-hunk content line never is.
  const diffWithTrickyAddedLine = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,3 +1,4 @@",
    " line1",
    "+++ x;",
    " line2",
    " line3",
    "",
  ].join("\n");

  const hunks = parseDiffHunks(diffWithTrickyAddedLine);
  assert.deepEqual(Array.from(hunks.get("a.ts") ?? []).sort((a, b) => a - b), [1, 2, 3, 4]);
  assert.equal(hunks.has("x;"), false, "must not have been misparsed as its own file");
});

test("ignores a deleted file's hunk (+++ /dev/null), since there's no new-file line to anchor to", () => {
  const deletionDiff = [
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-line1",
    "-line2",
    "",
  ].join("\n");

  const hunks = parseDiffHunks(deletionDiff);
  assert.equal(hunks.has("gone.ts"), false);
  assert.equal(hunks.size, 0);
});

test("real `git diff` output for a multi-hunk change parses to the expected new-side lines", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scrutineer-diff-hunks-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const git = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf-8" });

  git(["init", "-b", "main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);

  const original = Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
  writeFileSync(join(dir, "file.ts"), original);
  git(["add", "."]);
  git(["commit", "-m", "base"]);

  const lines = original.split("\n");
  lines.splice(1, 1, "line2-changed"); // change near the top
  lines.splice(11, 0, "line11.5-new"); // insert near the bottom
  writeFileSync(join(dir, "file.ts"), lines.join("\n"));

  const diffText = execFileSync("git", ["diff", "--no-color", "--", "file.ts"], { cwd: dir, encoding: "utf-8" });
  const hunks = parseDiffHunks(diffText);
  const validLines = hunks.get("file.ts") ?? new Set();

  // The two edits are far enough apart that git emits separate hunks; both
  // touched regions should validate, and untouched lines in between shouldn't.
  assert.ok(validLines.has(2), "changed line should validate");
  assert.ok(validLines.has(12) || validLines.has(13), "inserted line should validate");
  assert.equal(validLines.has(7), false, "an untouched line far from either hunk should not validate");
});

test("resolveInlineLocation keeps the line when it falls inside a hunk", () => {
  const hunks = parseDiffHunks(MULTI_HUNK_DIFF);
  assert.deepEqual(resolveInlineLocation({ file: "src/foo.ts", line: 2 }, hunks), {
    file: "src/foo.ts",
    line: 2,
  });
});

test("resolveInlineLocation downgrades to file-level when the line falls outside every hunk", () => {
  const hunks = parseDiffHunks(MULTI_HUNK_DIFF);
  assert.deepEqual(resolveInlineLocation({ file: "src/foo.ts", line: 100 }, hunks), {
    file: "src/foo.ts",
  });
});

test("resolveInlineLocation downgrades to file-level when the finding's file isn't in the diff at all", () => {
  const hunks = parseDiffHunks(MULTI_HUNK_DIFF);
  assert.deepEqual(resolveInlineLocation({ file: "unrelated.ts", line: 1 }, hunks), {
    file: "unrelated.ts",
  });
});

test("resolveInlineLocation passes through a finding that never had a line", () => {
  const hunks = parseDiffHunks(MULTI_HUNK_DIFF);
  assert.deepEqual(resolveInlineLocation({ file: "src/foo.ts", line: null }, hunks), { file: "src/foo.ts" });
});
