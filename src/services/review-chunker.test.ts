import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunkChangedFiles,
  chunkChangedFilesWithDependencies,
  exceedsMaxFilesForPrReview,
  exceedsMaxTotalFiles,
  groupFilesByDependency,
  MAX_FILES_FOR_PR_REVIEW,
  MAX_FILES_PER_CHUNK,
  MAX_TOTAL_FILES,
} from "./review-chunker.js";

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

test("exceedsMaxFilesForPrReview is false at and under the limit, true just over it", () => {
  assert.equal(exceedsMaxFilesForPrReview(Array.from({ length: 10 }, (_, i) => `f${i}.ts`), 10), false);
  assert.equal(exceedsMaxFilesForPrReview(Array.from({ length: 11 }, (_, i) => `f${i}.ts`), 10), true);
});

test("exceedsMaxFilesForPrReview uses MAX_FILES_FOR_PR_REVIEW as its default", () => {
  assert.equal(exceedsMaxFilesForPrReview(Array.from({ length: MAX_FILES_FOR_PR_REVIEW }, (_, i) => `f${i}.ts`)), false);
  assert.equal(exceedsMaxFilesForPrReview(Array.from({ length: MAX_FILES_FOR_PR_REVIEW + 1 }, (_, i) => `f${i}.ts`)), true);
});

test("groupFilesByDependency puts unrelated files each in their own singleton group, in original order", () => {
  const files = ["a.ts", "b.ts", "c.ts"];
  assert.deepEqual(groupFilesByDependency(files, () => []), [["a.ts"], ["b.ts"], ["c.ts"]]);
});

test("groupFilesByDependency groups a file with the sibling it imports via a relative specifier", () => {
  const files = ["src/components/Foo.tsx", "src/app/page.tsx", "src/unrelated.ts"];
  const imports: Record<string, string[]> = {
    "src/app/page.tsx": ["../components/Foo"],
  };
  const groups = groupFilesByDependency(files, (f) => imports[f] ?? []);

  assert.equal(groups.length, 2);
  const linkedGroup = groups.find((g) => g.length === 2);
  assert.deepEqual(new Set(linkedGroup), new Set(["src/components/Foo.tsx", "src/app/page.tsx"]));
});

test("groupFilesByDependency transitively links a chain of imports into one group", () => {
  const files = ["a.ts", "b.ts", "c.ts"];
  const imports: Record<string, string[]> = {
    "a.ts": ["./b"],
    "b.ts": ["./c"],
  };
  const groups = groupFilesByDependency(files, (f) => imports[f] ?? []);

  assert.equal(groups.length, 1);
  assert.deepEqual(new Set(groups[0]), new Set(files));
});

test("groupFilesByDependency ignores a bare/package import specifier", () => {
  const files = ["a.ts", "b.ts"];
  const imports: Record<string, string[]> = { "a.ts": ["react"] };
  assert.deepEqual(groupFilesByDependency(files, (f) => imports[f] ?? []), [["a.ts"], ["b.ts"]]);
});

test("groupFilesByDependency ignores a relative import that doesn't resolve to a file in the batch", () => {
  const files = ["a.ts", "b.ts"];
  const imports: Record<string, string[]> = { "a.ts": ["./not-in-batch"] };
  assert.deepEqual(groupFilesByDependency(files, (f) => imports[f] ?? []), [["a.ts"], ["b.ts"]]);
});

test("chunkChangedFilesWithDependencies matches the naive chunker when no dependency links exist", () => {
  const files = Array.from({ length: 15 }, (_, i) => `file${i}.ts`);
  assert.deepEqual(
    chunkChangedFilesWithDependencies(files, () => [], 10),
    chunkChangedFiles(files, 10),
  );
});

test("chunkChangedFilesWithDependencies keeps a dependent pair together across a chunk boundary", () => {
  const files = [...Array.from({ length: 9 }, (_, i) => `file${i}.ts`), "src/components/Foo.tsx", "src/app/page.tsx"];
  const imports: Record<string, string[]> = { "src/app/page.tsx": ["../components/Foo"] };

  const chunks = chunkChangedFilesWithDependencies(files, (f) => imports[f] ?? [], 10);

  const chunkContaining = (file: string) => chunks.find((chunk) => chunk.includes(file));
  assert.deepEqual(chunkContaining("src/components/Foo.tsx"), chunkContaining("src/app/page.tsx"));
});
