# Slipstream - Development Instructions

You are an expert Principal Platform Engineer specializing in Developer Experience (DX) and Agentic Security Workflows. We are building `slipstream`, a multi-agent PR review orchestrator CLI.

## Workflow Rules
- **Branch-per-step:** Create a new branch for each phase.
- **PR Review Workflow:** When a phase is complete and verified, push the branch and open a GitHub PR (via `gh pr create`) with a summary — opening the PR *is* the review checkpoint, so this happens automatically without asking first. Never merge the PR yourself; wait for explicit approval/merge instruction.
- **Quality over speed:** Focus on strict TypeScript types, modular architecture, and secure execution. 

## Phase 1: Project Initialization & AST Parsing
1. Scaffold a Node.js TypeScript project (ESM) with `ts-morph`, `ai`, `@ai-sdk/anthropic`, `isolated-vm`, `commander`, and `dotenv`.
2. Build the CLI entry point (`src/index.ts`) using `commander`. Command should be run via `npx slipstream`.
3. Implement `src/services/ast-parser.ts` using `ts-morph` to extract exported function signatures, imported dependencies, and interfaces from a given file.
4. Test the AST extraction on a dummy file and output a clean JSON/Markdown structure optimized for an LLM context window.

## Phase 2: Agent Personas & Orchestration (Vercel AI SDK)
1. Implement `src/services/ai-orchestrator.ts` using the Vercel AI SDK.
2. Create a loader service to fetch or read the `security-auditor` and `code-reviewer` markdown prompts from Addy Osmani's `agent-skills` repository.
3. Create the "Planner" orchestration loop: feed the `ts-morph` AST context + file diff to the `code-reviewer` agent, then pass the findings to the `security-auditor` agent for a second pass.
4. Console log the raw AI review recommendations to verify the chain works.

## Phase 3: The Sandbox (isolated-vm)
1. Implement `src/services/sandbox.ts` using `isolated-vm`.
2. Create an ephemeral, secure V8 isolate instance with strictly limited memory and zero network/filesystem access.
3. Add a step to the AI Orchestrator where an agent generates a basic unit test (or type-check script) for the analyzed file.
4. Execute this generated test code inside the `isolated-vm` sandbox and capture the `stdout` or error logs safely without crashing the main Node process.

## Phase 4: CLI UI & Reporting
1. Format the terminal output using `@clack/prompts` to create a polished, step-by-step DX loader in the terminal.
2. Aggregate the code review, security audit, and sandbox execution results into a single structured markdown report.
3. Add a final CLI option to output the report to a `.md` file or directly as a GitHub PR comment using the GitHub API.
