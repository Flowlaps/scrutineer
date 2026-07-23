// A --diff batch large enough to need multiple review calls (issue #35: even
// with resolveMaxOutputTokens() scaling the per-call output budget, a single
// call still has a hard ceiling — see ai-orchestrator.ts's OUTPUT_TOKENS_CEILING)
// gets split into fixed-size groups of files, each reviewed as its own smaller
// batch and aggregated back into one report. Not byte-size-aware — a handful of
// individually huge files can still land in one chunk and hit the existing
// truncation-notice mechanism; that's a deliberate v1 scoping decision, not
// something this module tries to solve.
export const MAX_FILES_PER_CHUNK = 10;

// A ceiling on total files, independent of MAX_FILES_PER_CHUNK (which only
// bounds each individual chunk's size, not how many chunks a batch produces).
// Without this, a pathological diff — thousands of changed files, e.g. from
// --diff against an unrelated branch, or an accidentally-included generated/
// vendored directory — would still chunk cleanly and then fire an unbounded
// number of AI calls, one pair per chunk, with no ceiling anywhere on total
// API cost or wall-clock time. 300 files (30 chunks) comfortably covers the
// "hundreds of files" case issue #35 was written to solve, while still
// refusing a genuinely unbounded batch outright rather than quietly grinding
// through it.
export const MAX_TOTAL_FILES = 300;

export function exceedsMaxTotalFiles(files: string[], maxTotalFiles: number = MAX_TOTAL_FILES): boolean {
  return files.length > maxTotalFiles;
}

export function chunkChangedFiles(files: string[], maxFilesPerChunk: number = MAX_FILES_PER_CHUNK): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < files.length; i += maxFilesPerChunk) {
    chunks.push(files.slice(i, i + maxFilesPerChunk));
  }
  return chunks;
}
