// Parses unified-diff hunk headers (`@@ -a,b +c,d @@`) into a per-file set of
// line numbers that are actually present in the diff, on the *new* (post-change)
// side. A finding's `line` (ReviewFinding, review-schema.ts) has to be checked
// against this before it can anchor a GitHub inline review comment (issue #46) —
// the Reviews API rejects a comment anchored to a line the diff never touched,
// so that has to be caught here rather than surfacing as a failed API call.

const FILE_HEADER_PATTERN = /^\+\+\+ (?:b\/)?(.+)$/;
const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseDiffHunks(diffText: string): Map<string, Set<number>> {
  const linesByFile = new Map<string, Set<number>>();
  let currentFile: string | null = null;
  let newLine = 0;

  for (const line of diffText.split("\n")) {
    const fileMatch = line.match(FILE_HEADER_PATTERN);
    if (fileMatch) {
      const path = fileMatch[1];
      currentFile = path && path !== "/dev/null" ? path : null;
      newLine = 0;
      continue;
    }

    const hunkMatch = line.match(HUNK_HEADER_PATTERN);
    if (hunkMatch) {
      newLine = Number(hunkMatch[1] ?? 0);
      if (currentFile && !linesByFile.has(currentFile)) {
        linesByFile.set(currentFile, new Set());
      }
      continue;
    }

    if (!currentFile || newLine === 0) {
      continue;
    }

    if (line.startsWith("+")) {
      linesByFile.get(currentFile)?.add(newLine);
      newLine++;
    } else if (line.startsWith(" ")) {
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
  finding: { file: string; line?: number },
  hunkLines: Map<string, Set<number>>,
): FindingLocation {
  if (finding.line !== undefined && hunkLines.get(finding.file)?.has(finding.line)) {
    return { file: finding.file, line: finding.line };
  }
  return { file: finding.file };
}
