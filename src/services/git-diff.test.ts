import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChangedFiles, getDiffAgainstTarget } from "./git-diff.js";
import { parseDiffHunks } from "./diff-hunks.js";
import { MAX_SECTION_CHARS } from "./ai-orchestrator.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

function setupRepo(t: import("node:test").TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "scrutineer-git-diff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);

  writeFileSync(join(dir, "base.ts"), "export const base = 1;\n");
  writeFileSync(join(dir, "README.md"), "# hi\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);

  git(dir, ["checkout", "-b", "feature"]);
  writeFileSync(join(dir, "base.ts"), "export const base = 2;\n");
  writeFileSync(join(dir, "widget.tsx"), "export const Widget = () => null;\n");
  writeFileSync(join(dir, "notes.md"), "changed docs\n");
  writeFileSync(join(dir, "script.js"), "console.log('hi');\n");
  writeFileSync(join(dir, "package.json"), '{"name":"example"}\n');
  writeFileSync(join(dir, "next.config.js"), "module.exports = {};\n");
  writeFileSync(join(dir, "migration.sql"), "ALTER TABLE users ADD COLUMN email TEXT;\n");
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(dir, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(join(dir, "yarn.lock"), "# yarn lockfile v1\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "feature work"]);

  return dir;
}

test("getChangedFiles returns the changed .ts/.tsx files vs the target ref", (t) => {
  const dir = setupRepo(t);
  const files = getChangedFiles("main", dir).sort();
  assert.deepEqual(files, [
    "base.ts",
    "migration.sql",
    "next.config.js",
    "package-lock.json",
    "package.json",
    "pnpm-lock.yaml",
    "widget.tsx",
    "yarn.lock",
  ]);
});

test("getChangedFiles also keeps dynamic-skill trigger filenames (package.json, next.config.*, lockfiles, *.sql) that aren't .ts/.tsx, but still drops unrelated non-.ts files", (t) => {
  const dir = setupRepo(t);
  const files = getChangedFiles("main", dir);
  assert.ok(files.includes("package.json"));
  assert.ok(files.includes("next.config.js"));
  assert.ok(files.includes("migration.sql"));
  assert.ok(files.includes("pnpm-lock.yaml"));
  assert.ok(files.includes("package-lock.json"));
  assert.ok(files.includes("yarn.lock"));
  assert.ok(!files.includes("notes.md"));
  assert.ok(!files.includes("script.js"));
});

test("getChangedFiles throws a friendly error for an unreachable target ref", (t) => {
  const dir = setupRepo(t);
  assert.throws(
    () => getChangedFiles("origin/does-not-exist", dir),
    /could not diff against "origin\/does-not-exist"/,
  );
});

test("getChangedFiles rejects a target starting with '-' instead of passing it through to git as a flag", (t) => {
  const dir = setupRepo(t);
  const outputPath = join(dir, "pwned.txt");
  assert.throws(() => getChangedFiles(`--output=${outputPath}`, dir), /not a valid git ref/);
  assert.equal(existsSync(outputPath), false, "git must never see the injected --output flag");
});

test("getDiffAgainstTarget rejects a target starting with '-' instead of passing it through to git as a flag", (t) => {
  const dir = setupRepo(t);
  assert.throws(
    () => getDiffAgainstTarget("--output=/tmp/scrutineer-should-not-exist.txt", ["base.ts"], dir),
    /not a valid git ref/,
  );
});

test("getDiffAgainstTarget returns diff content scoped to the given files", (t) => {
  const dir = setupRepo(t);
  const diff = getDiffAgainstTarget("main", ["base.ts"], dir);
  assert.match(diff, /base\.ts/);
  assert.match(diff, /-export const base = 1;/);
  assert.match(diff, /\+export const base = 2;/);
  assert.doesNotMatch(diff, /widget\.tsx/);
});

test("getDiffAgainstTarget omits lockfile diff bodies (replaced with a --stat summary) so they can't crowd out real code changes", (t) => {
  const dir = setupRepo(t);
  const diff = getDiffAgainstTarget(
    "main",
    ["base.ts", "pnpm-lock.yaml", "package-lock.json", "yarn.lock"],
    dir,
  );

  // The real code diff is untouched.
  assert.match(diff, /base\.ts/);
  assert.match(diff, /-export const base = 1;/);
  assert.match(diff, /\+export const base = 2;/);

  // Lockfiles are named (so the model still knows they changed) but their line
  // content never appears — proving the body was omitted, not merely truncated.
  assert.match(diff, /pnpm-lock\.yaml/);
  assert.match(diff, /package-lock\.json/);
  assert.match(diff, /yarn\.lock/);
  assert.doesNotMatch(diff, /lockfileVersion/);
  assert.doesNotMatch(diff, /yarn lockfile v1/);
});

test("getDiffAgainstTarget returns just the lockfile stat summary when only lockfiles changed", (t) => {
  const dir = setupRepo(t);
  const diff = getDiffAgainstTarget("main", ["pnpm-lock.yaml", "yarn.lock"], dir);
  assert.match(diff, /pnpm-lock\.yaml/);
  assert.match(diff, /yarn\.lock/);
  assert.doesNotMatch(diff, /lockfileVersion/);
});

test("getDiffAgainstTarget keeps a code change intact under MAX_SECTION_CHARS even alongside a lockfile diff that would blow the budget on its own (GH #31)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scrutineer-git-diff-lockfile-budget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);

  writeFileSync(join(dir, "app.ts"), "export const app = 1;\n");
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);

  git(dir, ["checkout", "-b", "feature"]);
  writeFileSync(join(dir, "app.ts"), "export const app = 2;\n");
  // A synthetic but realistic lockfile diff (thousands of dependency-version
  // lines), reproducing the exact scenario from issue #31: a transitive
  // dependency bump large enough that its raw diff body, on its own, would
  // exceed MAX_SECTION_CHARS and could push the real code change out of what
  // the model ever sees once ai-orchestrator.ts truncates the combined string.
  const lockfileLines = Array.from({ length: 3000 }, (_, i) => `dependency-${i}: ^1.0.${i}`);
  const rawLockfileBodyLength = lockfileLines.join("\n").length;
  assert.ok(
    rawLockfileBodyLength > MAX_SECTION_CHARS,
    "test setup sanity check: the raw lockfile content must exceed MAX_SECTION_CHARS on its own",
  );
  writeFileSync(join(dir, "pnpm-lock.yaml"), `${lockfileLines.join("\n")}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "bump a transitive dependency"]);

  const diff = getDiffAgainstTarget("main", ["app.ts", "pnpm-lock.yaml"], dir);

  assert.ok(
    diff.length < MAX_SECTION_CHARS,
    `expected the combined diff (${diff.length} chars) to stay under MAX_SECTION_CHARS ` +
      `(${MAX_SECTION_CHARS}) so ai-orchestrator.ts never has to truncate it — got a diff that ` +
      "would have been over budget before this fix",
  );
  assert.match(diff, /-export const app = 1;/);
  assert.match(diff, /\+export const app = 2;/);
  assert.doesNotMatch(diff, /dependency-0:/);
});

test("getDiffAgainstTarget preserves rename detection for a renamed-and-edited file (issue #63)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scrutineer-git-diff-rename-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);

  const original = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
  mkdirSync(join(dir, "import"));
  writeFileSync(join(dir, "import", "driver.ts"), original);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);

  git(dir, ["checkout", "-b", "feature"]);
  git(dir, ["mv", "import/driver.ts", "driver.ts"]);
  const moved = original + "export function extra() {}\n";
  writeFileSync(join(dir, "driver.ts"), moved);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "move and extend driver"]);

  const files = getChangedFiles("main", dir);
  assert.deepEqual(files, ["driver.ts"]);

  const diff = getDiffAgainstTarget("main", files, dir);

  // A correctly rename-paired diff shows the move and only the appended line
  // as new — not the whole file re-created from /dev/null.
  assert.match(diff, /rename from import\/driver\.ts/);
  assert.match(diff, /rename to driver\.ts/);
  assert.doesNotMatch(diff, /new file mode/);

  const hunks = parseDiffHunks(diff);
  const validLines = hunks.get("driver.ts") ?? new Set();
  assert.equal(validLines.has(21), true, "the appended line should validate");
  assert.equal(validLines.has(1), false, "untouched pre-existing content must not be treated as diff-touched");
});

test("getDiffAgainstTarget throws a friendly error for an unreachable target ref, not a raw git failure", (t) => {
  const dir = setupRepo(t);
  assert.throws(
    () => getDiffAgainstTarget("origin/does-not-exist", ["base.ts"], dir),
    /could not diff against "origin\/does-not-exist"/,
  );
});

test("getDiffAgainstTarget doesn't throw ENOBUFS when the target range contains a large file outside the reviewed set (PR #65 review)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scrutineer-git-diff-large-range-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);

  writeFileSync(join(dir, "small.ts"), "export const small = 1;\n");
  writeFileSync(join(dir, "generated.json"), "{}\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);

  git(dir, ["checkout", "-b", "feature"]);
  writeFileSync(join(dir, "small.ts"), "export const small = 2;\n");
  // Unrestricted `git diff target...HEAD` (no `-- <pathspec>`, needed to keep
  // rename pairing intact) buffers this file's diff too, even though it's not
  // one of the files under review — large enough on its own to blow Node's
  // execFileSync default 1MB maxBuffer, well within GIT_DIFF_MAX_BUFFER_BYTES.
  const largeLines = Array.from({ length: 60_000 }, (_, i) => `"key-${i}": "value-${i}"`);
  writeFileSync(join(dir, "generated.json"), `{\n${largeLines.join(",\n")}\n}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "regenerate a large unrelated file"]);

  const diff = getDiffAgainstTarget("main", ["small.ts"], dir);
  assert.match(diff, /-export const small = 1;/);
  assert.match(diff, /\+export const small = 2;/);
  assert.doesNotMatch(diff, /generated\.json/);
});

test("getDiffAgainstTarget scrubs values that look like secrets", (t) => {
  const dir = setupRepo(t);
  const secret = `sk-${"a".repeat(24)}`;
  writeFileSync(join(dir, "base.ts"), `export const key = "${secret}";\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "add secret"]);

  const diff = getDiffAgainstTarget("main", ["base.ts"], dir);
  assert.doesNotMatch(diff, new RegExp(secret));
  assert.match(diff, /\[REDACTED\]/);
});
