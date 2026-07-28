import type { ReviewResult, TruncationNotice } from "./ai-orchestrator.js";
import type { ProviderId } from "../utils/model-factory.js";

export interface ReportInput {
  filePath: string;
  provider: ProviderId;
  model: string;
  result: ReviewResult;
  generatedAt?: Date;
}

/**
 * Picks a fence at least one backtick longer than the longest backtick run in
 * `code`, so a generated snippet containing its own ``` can't prematurely
 * close the fence and corrupt the rest of the report.
 */
export function codeFence(code: string): string {
  const runs = code.match(/`+/g) ?? [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longestRun + 1));
}

const CONFIDENCE_LOG_PATTERN = /^CONFIDENCE:\s*(.+)$/im;

function findConfidenceNote(logs: string[]): string | undefined {
  const match = logs.join("\n").match(CONFIDENCE_LOG_PATTERN);
  return match?.[1]?.trim();
}

// Exported so inline-review.ts (issue #46 step 4) can home the Sandbox Test
// section in a PR review's top-level cover-note body instead of duplicating
// this rendering — the sandbox result doesn't anchor to any one diff line, so
// it never becomes a per-line inline comment either way.
export function buildSandboxSection(sandboxTest: ReviewResult["sandboxTest"]): string[] {
  const sandboxStatus = sandboxTest.result.ok ? "PASS" : "FAILED";
  const fence = codeFence(sandboxTest.code);

  const sections = ["## Sandbox Test", "", `**Result:** ${sandboxStatus}`, ""];

  if (!sandboxTest.result.ok) {
    const confidence = findConfidenceNote(sandboxTest.result.logs);
    sections.push(
      confidence
        ? `**Confidence:** ${confidence}`
        : "**Confidence:** unclear — this is a smoke test the model reimplemented from the diff, not the " +
            "reviewed file itself, so a FAILED result may point to a bug in that reimplementation rather than " +
            "the code under review.",
      "",
    );
  }

  const detail = [`${fence}js`, sandboxTest.code, fence];

  if (sandboxTest.result.logs.length > 0) {
    detail.push("", "**Logs:**", "");
    detail.push(...sandboxTest.result.logs.map((line) => `- ${line}`));
  }

  if (sandboxTest.result.errors.length > 0) {
    detail.push("", "**Errors:**", "");
    detail.push(...sandboxTest.result.errors.map((line) => `- ${line}`));
  }

  // Collapsed behind a <details> disclosure so a trivial diff's report doesn't
  // dump a full generated test script every time (issue #42) — the PASS/FAILED
  // line above already tells a skimming reader what they need; the code and
  // logs are there on demand. Left open by default on a failure, since that's
  // exactly the case where a reader needs the detail without an extra click.
  sections.push(`<details${sandboxTest.result.ok ? "" : " open"}>`, "<summary>Generated test & output</summary>", "");
  sections.push(...detail);
  sections.push("", "</details>");

  return sections;
}

// Exported so inline-review.ts can render the same banner in its cover note.
export function buildTruncationNotice(truncations: TruncationNotice[]): string[] {
  if (truncations.length === 0) {
    return [];
  }
  const totalOmittedChars = truncations.reduce((sum, notice) => sum + notice.omittedChars, 0);
  return [
    `⚠️ **This review was truncated** — ${totalOmittedChars} character(s) across ${truncations.length} ` +
      "section(s) were omitted before being sent to the model. Some findings may be incomplete. See the " +
      "Actions log (or stderr) for the full, untruncated content.",
    "",
  ];
}

export function buildReportMarkdown(input: ReportInput): string {
  const { filePath, provider, model, result, generatedAt = new Date() } = input;
  const { codeReview, securityAudit, sandboxTest, truncations } = result;

  const sections = [
    "# Scrutineer Review Report",
    "",
    ...buildTruncationNotice(truncations),
    `- **File:** \`${filePath}\``,
    `- **Provider:** ${provider}`,
    `- **Model:** ${model}`,
    `- **Generated:** ${generatedAt.toISOString()}`,
    "",
    "## Code Review",
    "",
    codeReview.markdown,
    "",
    "## Security Audit",
    "",
    securityAudit.markdown,
    "",
    ...buildSandboxSection(sandboxTest),
  ];

  return sections.join("\n");
}
