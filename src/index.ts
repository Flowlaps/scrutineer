#!/usr/bin/env node
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { Command, Option } from "commander";
import * as clack from "@clack/prompts";
import { parseFile, summaryToMarkdown } from "./services/ast-parser.js";
import { getFileDiff, getChangedFiles, getDiffAgainstTarget } from "./services/git-diff.js";
import { runReviewPipeline, type ReviewStage } from "./services/ai-orchestrator.js";
import { buildReportMarkdown } from "./services/report.js";
import { getRepoSlugFromGit, postPrComment } from "./services/github-client.js";
import { MODEL_ENV_VAR, PROVIDER_IDS, type ProviderId } from "./utils/model-factory.js";

const program = new Command();

program
  .name("scrutineer")
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
      console.error(`scrutineer: failed to parse "${file}": ${message}`);
      process.exitCode = 1;
      return;
    }
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(summaryToMarkdown(summary));
    }
  });

const STAGE_MESSAGES: Record<ReviewStage, string> = {
  "loading-personas": "Loading reviewer personas...",
  "code-review": "Running code-reviewer pass...",
  "security-audit": "Running security-auditor pass...",
  "sandbox-test": "Generating and executing sandbox test...",
};

interface ReviewOptions {
  provider: ProviderId;
  output?: string;
  pr?: string;
  repo?: string;
  diff?: string;
}

program
  .command("review")
  .description(
    "Run the code-reviewer and security-auditor AI agents against a file's diff",
  )
  .argument("[file]", "path to the TypeScript file to review (omit when using --diff)")
  .addOption(
    new Option("--provider <type>", "AI provider to use for the review agents")
      .choices(PROVIDER_IDS)
      .default("anthropic"),
  )
  .option("--output <path>", "write the aggregated report to a Markdown file")
  .option("--pr <number>", "post the aggregated report as a comment on this PR number")
  .option("--repo <owner/repo>", "GitHub repo slug for --pr (defaults to the origin remote)")
  .option(
    "--diff <target>",
    "review every changed .ts/.tsx file against this git ref (e.g. origin/main) as a single batch, instead of one file",
  )
  .addHelpText(
    "after",
    "\nEnvironment variables:\n" +
      `  ${MODEL_ENV_VAR.anthropic}   override the default model for --provider anthropic\n` +
      `  ${MODEL_ENV_VAR.ollama}      override the default model for --provider ollama\n` +
      "  See .env.example for the current defaults and other supported variables.",
  )
  .action(async (file: string | undefined, options: ReviewOptions) => {
    if (!file && !options.diff) {
      console.error("scrutineer: provide a file path or --diff <target>");
      process.exitCode = 1;
      return;
    }
    if (file && options.diff) {
      console.error("scrutineer: pass either a file path or --diff <target>, not both");
      process.exitCode = 1;
      return;
    }

    let githubTarget: { owner: string; repo: string; pr: number; token: string } | undefined;

    if (options.pr) {
      const prNumber = Number(options.pr);
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        console.error(`scrutineer: --pr must be a positive integer, got "${options.pr}"`);
        process.exitCode = 1;
        return;
      }
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        console.error("scrutineer: --pr requires a GITHUB_TOKEN environment variable");
        process.exitCode = 1;
        return;
      }
      const slug = options.repo
        ? { owner: options.repo.split("/")[0] ?? "", repo: options.repo.split("/")[1] ?? "" }
        : getRepoSlugFromGit();
      if (!slug || !slug.owner || !slug.repo) {
        console.error(
          "scrutineer: could not determine the GitHub repo — pass --repo owner/repo or run inside a repo with a GitHub origin remote",
        );
        process.exitCode = 1;
        return;
      }
      githubTarget = { ...slug, pr: prNumber, token };
    }

    clack.intro("scrutineer review");

    try {
      let astContext = "";
      let diff = "";
      let reportMarkdown = "";
      let label: string;

      if (options.diff) {
        let files: string[];
        try {
          files = getChangedFiles(options.diff);
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exitCode = 1;
          return;
        }
        if (files.length === 0) {
          clack.outro(`No changed .ts/.tsx files found vs ${options.diff}`);
          return;
        }

        label = `${files.length} file(s) changed vs ${options.diff}`;
        const diffTarget = options.diff;

        await clack.tasks([
          {
            title: `Parse AST for ${files.length} file(s)`,
            task: () => {
              astContext = files.map((f) => summaryToMarkdown(parseFile(f))).join("\n\n---\n\n");
              return "AST extracted";
            },
          },
          {
            title: `Compute diff vs ${diffTarget}`,
            task: () => {
              diff = getDiffAgainstTarget(diffTarget, files);
              return "Diff ready";
            },
          },
        ]);
      } else {
        label = file as string;

        await clack.tasks([
          {
            title: "Parse AST",
            task: () => {
              astContext = summaryToMarkdown(parseFile(label));
              return "AST extracted";
            },
          },
          {
            title: "Compute diff",
            task: () => {
              diff = getFileDiff(label);
              return "Diff ready";
            },
          },
        ]);
      }

      await clack.tasks([
        {
          title: `Run AI review pipeline (${options.provider})`,
          task: async (message) => {
            const result = await runReviewPipeline(
              { filePath: label, astContext, diff, provider: options.provider },
              (stage) => message(STAGE_MESSAGES[stage]),
            );
            reportMarkdown = buildReportMarkdown({
              filePath: label,
              provider: options.provider,
              result,
            });
            return "Review pipeline complete";
          },
        },
      ]);

      const deliveries: string[] = [];

      if (options.output) {
        await writeFile(options.output, reportMarkdown, "utf-8");
        deliveries.push(`written to ${options.output}`);
      }

      if (githubTarget) {
        const { url } = await postPrComment({ ...githubTarget, body: reportMarkdown });
        deliveries.push(`posted to ${url}`);
      }

      if (deliveries.length === 0) {
        clack.outro("Review complete");
        console.log(`\n${reportMarkdown}`);
      } else {
        clack.outro(`Report ${deliveries.join(" and ")}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      clack.log.error(message);
      clack.outro("Review failed");
      process.exitCode = 1;
    }
  });

program.parse();
