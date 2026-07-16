import { test } from "node:test";
import assert from "node:assert/strict";
import { runInSandbox } from "./sandbox.js";

test("captures console.log output", async () => {
  const result = await runInSandbox('console.log("hello"); console.log(1 + 1);');
  assert.equal(result.ok, true);
  assert.deepEqual(result.logs, ["hello", "2"]);
});

test("captures a syntax error instead of throwing", async () => {
  const result = await runInSandbox("this is not valid javascript (");
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1);
});

test("captures an uncaught exception instead of throwing", async () => {
  const result = await runInSandbox("throw new Error('boom');");
  assert.equal(result.ok, false);
  assert.equal(result.errors[0], "boom");
});

test("enforces the timeout without hanging the host", async () => {
  const start = Date.now();
  const result = await runInSandbox("while (true) {}", { timeoutMs: 300 });
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.match(result.errors[0] ?? "", /timed out/i);
  assert.ok(elapsed < 3000, `expected timeout to be enforced quickly, took ${elapsed}ms`);
});

test("survives a memory-limit kill without crashing or double-disposing", async () => {
  const bomb = "const arr = []; while (true) { arr.push(new Array(1e6).fill(0)); }";
  const result = await runInSandbox(bomb, { memoryLimitMb: 16, timeoutMs: 10_000 });
  assert.equal(result.ok, false);
  assert.match(result.errors[0] ?? "", /memory limit|allocation failed/i);
});

test("console.warn does not flip ok to false", async () => {
  const result = await runInSandbox('console.warn("just a heads up"); console.log("PASS");');
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("console.error and failed assertions still flip ok to false", async () => {
  const result = await runInSandbox('console.assert(1 === 2, "one is not two");');
  assert.equal(result.ok, false);
  assert.match(result.errors[0] ?? "", /one is not two/);
});

test("has no access to require, process, module, or fetch", async () => {
  const result = await runInSandbox(
    "console.log(typeof require, typeof process, typeof module, typeof globalThis.fetch);",
  );
  assert.equal(result.ok, true);
  assert.equal(result.logs[0], "undefined undefined undefined undefined");
});
