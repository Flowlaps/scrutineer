import type { ReviewResult } from "./ai-orchestrator.js";
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

export function buildReportMarkdown(input: ReportInput): string {
  const { filePath, provider, model, result, generatedAt = new Date() } = input;
  const { codeReview, securityAudit, sandboxTest } = result;
  const sandboxStatus = sandboxTest.result.ok ? "PASS" : "FAILED";
  const fence = codeFence(sandboxTest.code);

  const sections = [
    "# Scrutineer Review Report",
    "",
    `- **File:** \`${filePath}\``,
    `- **Provider:** ${provider}`,
    `- **Model:** ${model}`,
    `- **Generated:** ${generatedAt.toISOString()}`,
    "",
    "## Code Review",
    "",
    codeReview,
    "",
    "## Security Audit",
    "",
    securityAudit,
    "",
    "## Sandbox Test",
    "",
    `**Result:** ${sandboxStatus}`,
    "",
  ];

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

  return sections.join("\n");
}
