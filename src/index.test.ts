import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path, { join } from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("scrutineer review --help documents the SCRUTINEER_MODEL_* env vars", () => {
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "review", "--help"],
    { cwd: repoRoot, encoding: "utf-8" },
  );

  assert.match(output, /SCRUTINEER_MODEL_ANTHROPIC/);
  assert.match(output, /SCRUTINEER_MODEL_OLLAMA/);
  assert.match(output, /SCRUTINEER_MODEL_OPENAI/);
  assert.match(output, /SCRUTINEER_MODEL_GEMINI/);
});

test("scrutineer review --provider accepts openai and gemini", () => {
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "review", "--help"],
    { cwd: repoRoot, encoding: "utf-8" },
  );

  assert.match(output, /"openai"/);
  assert.match(output, /"gemini"/);
});

test("scrutineer review --help documents --diff", () => {
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "review", "--help"],
    { cwd: repoRoot, encoding: "utf-8" },
  );

  assert.match(output, /--diff <target>/);
});

test("scrutineer review --help documents -m, --model", () => {
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "review", "--help"],
    { cwd: repoRoot, encoding: "utf-8" },
  );

  assert.match(output, /-m, --model <name>/);
});

function runReview(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): { status: number | null; stdout: string; stderr: string; timedOut: boolean; elapsedMs: number } {
  const startedAt = Date.now();
  try {
    const stdout = execFileSync(process.execPath, ["--import", "tsx", "src/index.ts", "review", ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, ...options.env },
      timeout: options.timeoutMs,
      // execFileSync's default kill signal (SIGTERM) can be intercepted: @clack/
      // prompts' spinner registers its own SIGTERM handler to render a cancel
      // frame, and doing so happens to also stop the very interval leak this
      // suite guards against — so a genuinely hung process could still "exit"
      // via that unrelated handler before the timeout ever proves anything.
      // SIGKILL can't be caught, so a timeout here always means the child was
      // actually still running when we gave up on it.
      killSignal: options.timeoutMs !== undefined ? "SIGKILL" : undefined,
    });
    return { status: 0, stdout, stderr: "", timedOut: false, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    const e = error as { status: number | null; stdout: string; stderr: string; signal?: string | null };
    return {
      status: e.status,
      stdout: e.stdout,
      stderr: e.stderr,
      timedOut: e.signal === "SIGKILL",
      elapsedMs: Date.now() - startedAt,
    };
  }
}

test("scrutineer review fails with a friendly message when neither a file nor --diff is given", () => {
  const { status, stderr } = runReview([]);
  assert.equal(status, 1);
  assert.match(stderr, /provide a file path or --diff <target>/);
});

test("scrutineer review fails with a friendly message when both a file and --diff are given", () => {
  const { status, stderr } = runReview(["src/index.ts", "--diff", "main"]);
  assert.equal(status, 1);
  assert.match(stderr, /pass either a file path or --diff <target>, not both/);
});

test("scrutineer review --diff <bad-ref> fails with a friendly message, not a raw git stack trace", () => {
  const { status, stderr } = runReview(["--diff", "not-a-real-ref-hopefully"]);
  assert.equal(status, 1);
  assert.match(stderr, /could not diff against "not-a-real-ref-hopefully"/);
  assert.doesNotMatch(stderr, /at Object/); // no raw Node/git stack trace leaking through
});

test("scrutineer review --diff <target starting with '-'> is rejected before it reaches git", () => {
  const { status, stderr } = runReview(["--diff", "--output=/tmp/scrutineer-should-not-exist.txt"]);
  assert.equal(status, 1);
  assert.match(stderr, /not a valid git ref/);
});

test("scrutineer review exits promptly instead of hanging when the review pipeline itself fails (GH #28)", () => {
  // Points at a closed local port so the failure is a real async rejection from
  // inside the AI SDK's generateText call (not an early, pre-pipeline validation
  // error), fully offline and near-instant — this is what actually exercises the
  // bug: clack's `tasks()` helper leaks its spinner's setInterval when a task
  // rejects, which previously kept the process alive indefinitely after this
  // exact kind of failure. A bounded execFileSync timeout means a regression
  // fails this test instead of hanging the whole suite.
  const { status, stdout, timedOut, elapsedMs } = runReview(
    ["src/services/skill-router.ts", "--provider", "ollama"],
    { env: { OLLAMA_HOST: "http://127.0.0.1:1" }, timeoutMs: 30_000 },
  );
  assert.equal(timedOut, false, "process should exit on its own instead of being killed (SIGKILL) by the test timeout");
  // Belt-and-suspenders beyond the signal check above: assert actual wall-clock
  // time too, so this test can't be fooled by any other path — signal-based or
  // not — that happens to leave `status`/`stdout` looking like a prompt success
  // without the process actually having exited quickly on its own.
  assert.ok(
    elapsedMs < 15_000,
    `expected the process to exit well under the 30s test timeout, took ${elapsedMs}ms`,
  );
  assert.equal(status, 1);
  assert.match(stdout, /Review failed/);
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd });
}

// A fixture repo whose "feature" branch adds `fileCount` new .ts files vs
// "main" — enough to exercise chunkChangedFiles() splitting a --diff batch
// into more than one chunk (MAX_FILES_PER_CHUNK is 10 as of this writing).
function setupManyChangedFilesRepo(t: import("node:test").TestContext, fileCount: number): string {
  const dir = mkdtempSync(join(tmpdir(), "scrutineer-index-chunking-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "base.ts"), "export const base = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);

  git(dir, ["checkout", "-b", "feature"]);
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(dir, `file${i}.ts`), `export const value${i} = ${i};\n`);
  }
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "add many files"]);

  return dir;
}

test("scrutineer review --diff splits a batch bigger than MAX_FILES_PER_CHUNK into multiple review chunks (GH #35)", (t) => {
  const dir = setupManyChangedFilesRepo(t, 15); // > the 10-file default chunk size
  const scriptPath = path.join(repoRoot, "src/index.ts");

  let status: number | null;
  let combinedOutput: string;
  const startedAt = Date.now();
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "review", "--diff", "main", "--provider", "ollama"],
      {
        // cwd stays repoRoot so tsx/node_modules resolve normally (matching
        // every other test in this file) — GIT_DIR/GIT_WORK_TREE below point
        // git itself at the fixture repo instead, without needing the CLI's
        // own process.cwd() to change.
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_DIR: join(dir, ".git"),
          GIT_WORK_TREE: dir,
          // Unreachable host: same offline, fast-failing technique as the
          // GH #28 test above — proves the chunking wiring is reached
          // without paying for (or depending on) any real model call.
          OLLAMA_HOST: "http://127.0.0.1:1",
        },
        timeout: 30_000,
        killSignal: "SIGKILL",
      },
    );
    status = 0;
    combinedOutput = stdout;
  } catch (error) {
    const e = error as { status: number | null; stdout: string; stderr: string; signal?: string | null };
    assert.notEqual(e.signal, "SIGKILL", "process should fail fast instead of hanging until the timeout");
    status = e.status;
    combinedOutput = e.stdout + e.stderr;
  }
  const elapsedMs = Date.now() - startedAt;

  assert.equal(status, 1);
  assert.ok(elapsedMs < 15_000, `expected a prompt offline failure, took ${elapsedMs}ms`);
  assert.match(combinedOutput, /Batch split into 2 review chunks/);
});

test("scrutineer review --diff refuses a batch over the total-file limit instead of triggering an unbounded number of AI calls (GH #36 review)", (t) => {
  const dir = setupManyChangedFilesRepo(t, 301); // one over the 300-file MAX_TOTAL_FILES default
  const scriptPath = path.join(repoRoot, "src/index.ts");

  let status: number | null;
  let combinedOutput: string;
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", scriptPath, "review", "--diff", "main", "--provider", "ollama"],
      {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_DIR: join(dir, ".git"),
          GIT_WORK_TREE: dir,
          OLLAMA_HOST: "http://127.0.0.1:1",
        },
        timeout: 30_000,
        killSignal: "SIGKILL",
      },
    );
    status = 0;
    combinedOutput = stdout;
  } catch (error) {
    const e = error as { status: number | null; stdout: string; stderr: string };
    status = e.status;
    combinedOutput = e.stdout + e.stderr;
  }

  assert.equal(status, 1);
  assert.match(combinedOutput, /over the 300-file limit/);
  // Refused before ever getting to chunk/review the batch — proves this is an
  // upfront rejection, not a failed-partway-through run.
  assert.doesNotMatch(combinedOutput, /Batch split into/);
});
