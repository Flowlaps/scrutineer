import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkChangedFiles, exceedsMaxTotalFiles, MAX_FILES_PER_CHUNK, MAX_TOTAL_FILES } from "./review-chunker.js";

test("returns an empty array for an empty file list", () => {
  assert.deepEqual(chunkChangedFiles([]), []);
});

test("returns a single chunk containing every file when the batch fits within one chunk", () => {
  const files = ["a.ts", "b.ts", "c.ts"];
  assert.deepEqual(chunkChangedFiles(files, 10), [files]);
});

test("splits an exact multiple of the chunk size into evenly sized chunks", () => {
  const files = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
  const chunks = chunkChangedFiles(files, 10);
  assert.equal(chunks.length, 2);
  assert.deepEqual(chunks[0], files.slice(0, 10));
  assert.deepEqual(chunks[1], files.slice(10, 20));
});

test("puts the remainder in a smaller final chunk when the batch isn't an exact multiple", () => {
  const files = Array.from({ length: 11 }, (_, i) => `file${i}.ts`);
  const chunks = chunkChangedFiles(files, 10);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.length, 10);
  assert.equal(chunks[1]!.length, 1);
});

test("respects a custom maxFilesPerChunk override instead of the default", () => {
  const files = Array.from({ length: 6 }, (_, i) => `file${i}.ts`);
  const chunks = chunkChangedFiles(files, 2);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) {
    assert.equal(chunk.length, 2);
  }
});

test("MAX_FILES_PER_CHUNK is the default when no override is passed", () => {
  const files = Array.from({ length: MAX_FILES_PER_CHUNK + 5 }, (_, i) => `file${i}.ts`);
  const chunks = chunkChangedFiles(files);
  assert.equal(chunks[0]!.length, MAX_FILES_PER_CHUNK);
  assert.equal(chunks[1]!.length, 5);
});

test("preserves file order across chunk boundaries instead of reordering", () => {
  const files = Array.from({ length: 15 }, (_, i) => `file${i}.ts`);
  const chunks = chunkChangedFiles(files, 10);
  assert.deepEqual(chunks.flat(), files);
});

test("exceedsMaxTotalFiles is false at and under the limit, true just over it", () => {
  assert.equal(exceedsMaxTotalFiles(Array.from({ length: 300 }, (_, i) => `f${i}.ts`), 300), false);
  assert.equal(exceedsMaxTotalFiles(Array.from({ length: 301 }, (_, i) => `f${i}.ts`), 300), true);
});

test("exceedsMaxTotalFiles uses MAX_TOTAL_FILES as its default", () => {
  assert.equal(exceedsMaxTotalFiles(Array.from({ length: MAX_TOTAL_FILES }, (_, i) => `f${i}.ts`)), false);
  assert.equal(exceedsMaxTotalFiles(Array.from({ length: MAX_TOTAL_FILES + 1 }, (_, i) => `f${i}.ts`)), true);
});
