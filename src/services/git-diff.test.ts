import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChangedFiles, getDiffAgainstTarget } from "./git-diff.js";

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
