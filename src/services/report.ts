import type { ReviewResult } from "./ai-orchestrator.js";
import type { ProviderId } from "../utils/model-factory.js";

export interface ReportInput {
  filePath: string;
  provider: ProviderId;
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
  const { filePath, provider, result, generatedAt = new Date() } = input;
  const { codeReview, securityAudit, sandboxTest } = result;
  const sandboxStatus = sandboxTest.result.ok ? "PASS" : "FAILED";
  const fence = codeFence(sandboxTest.code);

  const sections = [
    "# Scrutineer Review Report",
    "",
    `- **File:** \`${filePath}\``,
    `- **Provider:** ${provider}`,
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
    `${fence}js`,
    sandboxTest.code,
    fence,
  ];

  if (sandboxTest.result.logs.length > 0) {
    sections.push("", "**Logs:**", "");
    sections.push(...sandboxTest.result.logs.map((line) => `- ${line}`));
  }

  if (sandboxTest.result.errors.length > 0) {
    sections.push("", "**Errors:**", "");
    sections.push(...sandboxTest.result.errors.map((line) => `- ${line}`));
  }

  return sections.join("\n");
}
