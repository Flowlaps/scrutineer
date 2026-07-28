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

// A much stricter ceiling than MAX_TOTAL_FILES, enforced only for --pr runs
// (issue #55): the resolved-thread suppression memory is only as useful as
// the review discipline behind it — a PR sprawling across dozens of files
// defeats the "≤3 rounds to mergeable" goal regardless of memory. Deliberately
// separate from the chunking ceilings above, which stay unchanged for --diff
// runs without --pr.
export const MAX_FILES_FOR_PR_REVIEW = 10;

export function exceedsMaxFilesForPrReview(files: string[], maxFiles: number = MAX_FILES_FOR_PR_REVIEW): boolean {
  return files.length > maxFiles;
}

// Resolves a relative import specifier (e.g. "./Foo", "../lib/utils") from
// `fromFile`'s own directory against the set of files actually in this batch,
// trying the same extension/index-file conventions Node/TypeScript resolution
// does. Returns undefined for a bare/package specifier (doesn't start with
// ".") or one that doesn't resolve to another file in the batch.
function resolveRelativeImport(fromFile: string, specifier: string, filesInBatch: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const dir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : "";
  const segments = `${dir}/${specifier}`.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  const resolvedSegments: string[] = [];
  for (const segment of segments) {
    if (segment === "..") {
      resolvedSegments.pop();
    } else {
      resolvedSegments.push(segment);
    }
  }
  const base = resolvedSegments.join("/");
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  return candidates.find((candidate) => filesInBatch.has(candidate));
}

// Groups files that import one another (directly, via a relative specifier
// resolving to another changed file) into the same group, via union-find —
// so a component and the page that renders it, for instance, land together
// rather than being split across chunks by chance of list position (issue
// #55's "widen the chunk" direction). A file with no in-batch relative import
// links is simply its own singleton group, so a batch with no detected
// dependencies groups identically to the plain per-file order below.
export function groupFilesByDependency(
  files: string[],
  importsOf: (file: string) => string[],
): string[][] {
  const filesInBatch = new Set(files);
  const parent = new Map<string, string>(files.map((f) => [f, f]));

  function find(file: string): string {
    let root = file;
    while (parent.get(root) !== root) {
      root = parent.get(root) as string;
    }
    parent.set(file, root);
    return root;
  }

  function union(a: string, b: string): void {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) {
      parent.set(rootA, rootB);
    }
  }

  for (const file of files) {
    for (const specifier of importsOf(file)) {
      const resolved = resolveRelativeImport(file, specifier, filesInBatch);
      if (resolved) {
        union(file, resolved);
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const file of files) {
    const root = find(file);
    const group = groups.get(root);
    if (group) {
      group.push(file);
    } else {
      groups.set(root, [file]);
    }
  }
  return Array.from(groups.values());
}

// Dependency-aware counterpart to chunkChangedFiles: packs each dependency
// group (see groupFilesByDependency) into a chunk without splitting it across
// two, so a known inter-file dependency stays visible to the same review call
// (issue #55). A group larger than maxFilesPerChunk on its own still lands in
// one (oversized) chunk — keeping a genuine dependency together takes
// priority over exact chunk sizing, which was always a soft target (see
// MAX_FILES_PER_CHUNK's own comment) rather than a hard cap. When no
// dependency links exist, every group is a singleton in original order, so
// packing produces byte-identical chunks to chunkChangedFiles().
export function chunkChangedFilesWithDependencies(
  files: string[],
  importsOf: (file: string) => string[],
  maxFilesPerChunk: number = MAX_FILES_PER_CHUNK,
): string[][] {
  const groups = groupFilesByDependency(files, importsOf);
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const group of groups) {
    if (current.length > 0 && current.length + group.length > maxFilesPerChunk) {
      chunks.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}
