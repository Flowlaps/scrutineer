import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("scrutineer review --help documents the SCRUTINEER_MODEL_* env vars", () => {
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/index.ts", "review", "--help"],
    { cwd: repoRoot, encoding: "utf-8" },
  );

  assert.match(output, /SCRUTINEER_MODEL_ANTHROPIC/);
  assert.match(output, /SCRUTINEER_MODEL_OLLAMA/);
});
