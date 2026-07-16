#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { parseFile, summaryToMarkdown } from "./services/ast-parser.js";
import { getFileDiff } from "./services/git-diff.js";
import { runReviewPipeline } from "./services/ai-orchestrator.js";

const program = new Command();

program
  .name("slipstream")
  .description("Multi-agent PR review orchestrator CLI")
  .version("0.1.0");

program
  .command("parse")
  .description("Extract exported functions, imports, and interfaces from a TypeScript file")
  .argument("<file>", "path to the TypeScript file to analyze")
  .option("-j, --json", "output raw JSON instead of Markdown")
  .action((file: string, options: { json?: boolean }) => {
    let summary;
    try {
      summary = parseFile(file);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`slipstream: failed to parse "${file}": ${message}`);
      process.exitCode = 1;
      return;
    }
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(summaryToMarkdown(summary));
    }
  });

program
  .command("review")
  .description(
    "Run the code-reviewer and security-auditor AI agents against a file's diff",
  )
  .argument("<file>", "path to the TypeScript file to review")
  .action(async (file: string) => {
    try {
      const astContext = summaryToMarkdown(parseFile(file));
      const diff = getFileDiff(file);
      const { codeReview, securityAudit } = await runReviewPipeline({
        filePath: file,
        astContext,
        diff,
      });

      console.log("\n=== Code Reviewer ===\n");
      console.log(codeReview);
      console.log("\n=== Security Auditor ===\n");
      console.log(securityAudit);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`slipstream: review failed: ${message}`);
      process.exitCode = 1;
    }
  });

program.parse();
