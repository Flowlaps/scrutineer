import type { ReviewFinding } from "./review-schema.js";

// Parses unified-diff hunk headers (`@@ -a,b +c,d @@`) into a per-file set of
// line numbers that are actually present in the diff, on the *new* (post-change)
// side. A finding's `line` (ReviewFinding, review-schema.ts) has to be checked
// against this before it can anchor a GitHub inline review comment (issue #46) —
// the Reviews API rejects a comment anchored to a line the diff never touched,
// so that has to be caught here rather than surfacing as a failed API call.

const OLD_FILE_HEADER_PATTERN = /^--- /;
const FILE_HEADER_PATTERN = /^\+\+\+ (?:b\/)?(.+)$/;
const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiffHunks(diffText: string): Map<string, Set<number>> {
  const linesByFile = new Map<string, Set<number>>();
  let currentFile: string | null = null;
  let newLine = 0;
  let previousLineWasOldFileHeader = false;

  for (const line of diffText.split("\n")) {
    // A raw diff line and a `+++`/`---` header line are distinguished only by a
    // single prepended character, so an *added* source line that happens to
    // read "++ something" becomes, once diffed, a line starting with "+++ " —
    // indistinguishable from a real file-header line by pattern alone (flagged
    // in PR #49 review). Requiring the "+++" line to immediately follow a
    // "--- " line (which every real file header pair has) rules out all but an
    // even more contrived two-line content coincidence.
    const linePrecededByOldFileHeader = previousLineWasOldFileHeader;
    previousLineWasOldFileHeader = OLD_FILE_HEADER_PATTERN.test(line);

    if (linePrecededByOldFileHeader) {
      const fileMatch = line.match(FILE_HEADER_PATTERN);
      if (fileMatch) {
        const path = fileMatch[1];
        currentFile = path && path !== "/dev/null" ? path : null;
        newLine = 0;
        continue;
      }
    }

    const hunkMatch = line.match(HUNK_HEADER_PATTERN);
    if (hunkMatch) {
      // Capture group 1 is required by the pattern (`\+(\d+)`), so it's always
      // defined whenever hunkMatch is truthy.
      newLine = Number(hunkMatch[1]);
      if (currentFile && !linesByFile.has(currentFile)) {
        linesByFile.set(currentFile, new Set());
      }
      continue;
    }

    if (!currentFile || newLine === 0) {
      continue;
    }

    if (line.startsWith("+") || line.startsWith(" ")) {
      linesByFile.get(currentFile)?.add(newLine);
      newLine++;
    }
    // Lines starting with "-" are removed-side only and don't occupy a line in
    // the new file, so the new-side counter doesn't advance for them. Anything
    // else (e.g. "\ No newline at end of file") is neither content nor a
    // counter-affecting line and is ignored.
  }

  return linesByFile;
}

export interface FindingLocation {
  file: string;
  line?: number;
}

// Downgrades a finding to a file-level location (no line) whenever its line
// isn't one the diff actually touched — either because the persona didn't
// report one, or because it reported one outside every hunk (hallucinated,
// stale, or referencing unchanged context far from the diff). Callers building
// inline review comments should only treat a finding as line-anchor-eligible
// when this returns a `line`; otherwise it still has a home (the review's
// top-level body / file-level listing), it just can't be a per-line GitHub
// comment.
export function resolveInlineLocation(
  finding: Pick<ReviewFinding, "file" | "line">,
  hunkLines: Map<string, Set<number>>,
): FindingLocation {
  if (finding.line != null && hunkLines.get(finding.file)?.has(finding.line)) {
    return { file: finding.file, line: finding.line };
  }
  return { file: finding.file };
}
