# Scrutineer - Development Instructions

You are an expert Principal Platform Engineer specializing in Developer Experience (DX) and Agentic Security Workflows. We are building `scrutineer`, a multi-agent PR review orchestrator CLI.

## Workflow Rules
- **Branch-per-step:** Create a new branch for each phase.
- **PR Review Workflow:** When a phase is complete and verified, push the branch and open a GitHub PR (via `gh pr create`) with a summary — opening the PR *is* the review checkpoint, so this happens automatically without asking first. Never merge the PR yourself; wait for explicit approval/merge instruction.
- **Quality over speed:** Focus on strict TypeScript types, modular architecture, and secure execution. 

## Phase 1: Project Initialization & AST Parsing
1. Scaffold a Node.js TypeScript project (ESM) with `ts-morph`, `ai`, `@ai-sdk/anthropic`, `isolated-vm`, `commander`, and `dotenv`.
2. Build the CLI entry point (`src/index.ts`) using `commander`. Command should be run via `npx scrutineer`.
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

## Phase 5: Project Documentation & Repository Polish

We have successfully built the core CLI, the provider-agnostic orchestrator, the AST parser, and the `isolated-vm` sandbox. Now we need to document the tool so it is immediately understandable for an engineering hiring manager.

Please create a new branch for Phase 5 and execute the following steps:

1. **Write the README.md:**
   - Create a clean, professional `README.md` at the root of the repository.
   - Use a human, direct tone. Avoid corporate buzzwords or overly formal AI-generated language (e.g., do not use words like "delve," "cutting-edge," or "harnessing").
   - Include the following sections:
     - **Overview:** A concise 2-sentence summary of what `scrutineer` does (an agentic PR review swarm CLI).
     - **Architecture Highlights:** Briefly mention the use of `ts-morph` for AST extraction, the Vercel AI SDK Model Factory (Anthropic/Ollama), and `isolated-vm` for secure sandboxing.
     - **Installation & Setup:** How to install dependencies, set `.env` variables, and pull the local Qwen model.
     - **Usage:** Provide a code block showing the CLI command (`npx scrutineer analyze ./src --provider ollama`).

2. **Generate an Architecture Document (`docs/ARCHITECTURE.md`):**
   - Create a brief, practical markdown document outlining the data flow.
   - Explain how the tool uses the "Planner/Swarm" pattern: extracting AST context, passing it to specialized Addy Osmani personas, and verifying the output in an air-gapped isolate.

3. **Establish the PR Template (`.github/pull_request_template.md`):**
   - Create a standard PR template matching our branch-per-step workflow.
   - Include sections for: Summary, Why, Scope, Files Changed, and Checks Run — with checkboxes for `npm run typecheck`, `npm run build`, `npm test`, and manual verification.

4. **Verify and Wrap Up:**
   - Ensure all markdown files are properly formatted and easy to read.
   - Generate a final PR summary for this documentation branch and pause for my review before merging.

## Phase 6: Architecture Diagram — Mermaid

The ASCII-art data-flow diagram in `docs/ARCHITECTURE.md` is hand-drawn and fragile to keep aligned as the pipeline evolves. Replace it with a Mermaid diagram, which GitHub renders natively in markdown with no extra tooling.

1. Create a new branch for Phase 6.
2. Replace the ASCII diagram in `docs/ARCHITECTURE.md` with a ` ```mermaid ` flowchart representing the same Planner pipeline: AST extraction → context assembly (diff + secret scrub) → code-reviewer → security-auditor → test-generation → isolated-vm sandbox → aggregated report → delivery (stdout / file / PR comment).
3. Preview the rendered markdown to confirm the diagram renders correctly on GitHub before opening the PR.
4. Push the branch and open a PR per the standard workflow.

## Phase 7: Parallelize Sandbox Test Generation

`generateSandboxTest` in `src/services/ai-orchestrator.ts` only depends on the AST context + diff — not on the code-review or security-audit findings — but currently runs after both passes complete, sequentially. Running it concurrently with the code-review/security-audit chain removes one round-trip from the pipeline's wall-clock latency at no cost.

1. Create a new branch for Phase 7.
2. In `runReviewPipeline`, kick off `generateSandboxTest` in parallel with the code-review/security-audit chain (e.g. via `Promise.all`) instead of sequencing it after them.
3. Update or add tests confirming the pipeline still returns the same `ReviewResult` shape and that all three model calls complete correctly when run concurrently.
4. Verify `npm run typecheck`, `npm run build`, and `npm test` pass, and manually time a `scrutineer review` run before/after to confirm the latency improvement.
5. Push the branch and open a PR per the standard workflow.

## Phase 8: Prompt Caching for Token Efficiency

The AST context + diff (up to 40K chars) is currently resent in full on every one of the three model calls in a single `review` run — a real intra-run duplication, since the code-review and test-generation prompts share an identical AST+diff prefix, and the security-audit prompt reuses that same prefix with the code-review findings appended after it. The code-reviewer and security-auditor persona system prompts (from `prompt-loader.ts`), by contrast, are each used only *once* per run — call 1 uses the code-reviewer prompt, call 2 uses the security-auditor prompt, and call 3 (test generation) uses its own hardcoded `TEST_GENERATOR_SYSTEM_PROMPT` in `ai-orchestrator.ts`, not a persona prompt at all — so caching those pays off only *across* separate `scrutineer review` invocations within the cache TTL (e.g. reviewing several files back to back), not within a single run.

Use Anthropic prompt caching (`@ai-sdk/anthropic`'s `providerOptions.anthropic.cacheControl`) to capture both wins:

1. Create a new branch for Phase 8.
2. In `src/services/ai-orchestrator.ts`, mark the AST-context/diff portion of the user prompt as cacheable (`cacheControl: { type: "ephemeral" }`) via `providerOptions.anthropic` on all three calls — this is the primary, intra-run win. Also mark each persona's system prompt as cacheable on its single call, for the smaller cross-invocation win.
3. Confirm this only applies to the `anthropic` provider — the `ollama` path has no caching support, so behavior for `ollama` must stay a no-op, not an error.
4. Capture and log token usage (`generateText`'s returned `usage`) per call so the caching effect is visible and verifiable, not just assumed.
5. Verify `npm run typecheck`, `npm run build`, and `npm test` pass. Confirm the AST/diff caching by comparing input-token cost between the first and later calls within one `review` run, and confirm the persona caching by running `scrutineer review` twice in a row and comparing the second run's cost to the first's.
6. Push the branch and open a PR per the standard workflow.

### Phase 9: Native Git Diffing (DX Improvement)

Remove the burden of writing complex bash `pre-push` hooks by moving Git diff resolution into the CLI natively using Node's `child_process`.

1. Use `commander` to add a new `--diff <target>` flag (e.g., `--diff origin/main`).
2. Use `child_process.execSync` to run `git diff --name-only <target>...HEAD`.
3.  Filter the output to only include `.ts` and `.tsx` files.
4. Fallback gracefully: If the git command fails (e.g., target ref doesn't exist), exit with a clear, user-friendly error message, not a raw stack trace.
5. The command should parse the AST for all files in the diff and send them to the agent swarm as a single batch for cross-file context.
6. Follow standard workflow around verification and open a PR.

## Phase 10: Multi-Provider Support (OpenAI & Gemini)

Expand the AI orchestration layer beyond Anthropic and Ollama to also support OpenAI and Google Gemini, proving out the Vercel AI SDK Model Factory's provider-agnostic design and avoiding vendor lock-in.

1. Create a new branch for Phase 10.
2. Install `@ai-sdk/openai` and `@ai-sdk/google`.
3. Update `src/utils/model-factory.ts` to route to `createOpenAI` and `createGoogleGenerativeAI` based on the provider string, alongside the existing `anthropic`/`ollama` cases, and add `openai`/`gemini` to `PROVIDER_IDS`.
4. Extend the `--provider <type>` flag's choices (`commander`) to include `openai` and `gemini`, keeping `anthropic` as the default so existing users and scripts aren't affected.
5. Follow the existing model-override convention: add `SCRUTINEER_MODEL_OPENAI` and `SCRUTINEER_MODEL_GEMINI` env vars (mirroring `SCRUTINEER_MODEL_ANTHROPIC`/`SCRUTINEER_MODEL_OLLAMA`) so a specific model can be selected per provider — there is no `--model` CLI flag today, so don't introduce one here.
6. Update `README.md`'s Configuration section to list `OPENAI_API_KEY` and `GOOGLE_GENERATIVE_AI_API_KEY` alongside the existing required/optional env vars.
7. Verify `npm run typecheck`, `npm run build`, and `npm test` pass, and manually confirm `scrutineer review <file> --provider openai` and `--provider gemini` both complete a real review.
8. Push the branch and open a PR per the standard workflow.

## Phase 11: Model Configurability & Intelligent Defaults

Allow users to specify the exact foundation model they want to use via the CLI, accommodating different reasoning capabilities and cost preferences.

1. Create a new branch for Phase 11.
2. Add a `-m, --model <name>` flag to the `commander` configuration.
3. If the user omits the `--model` flag, fall back to the provider's existing default — the current `DEFAULT_MODEL_ID` map in `src/utils/model-factory.ts` (and, for `ollama`, its existing auto-detection logic). No change to today's defaults; `--model` is purely an additive override.
4. Pass the resolved model string into the Model Factory, taking precedence over the existing `SCRUTINEER_MODEL_*` env var convention when both are set.
5. Ensure the CLI prints which provider and model are currently being used when starting the review, so the user has immediate feedback.
6. Document the `--model` flag in the README.
7. Verify `npm run typecheck`, `npm run build`, and `npm test` pass.
8. Push the branch and open a PR per the standard workflow.

## Phase 12: Dynamic Skill Routing (Context-Aware Personas)

Prevent LLM hallucination and context-window bloat by dynamically composing the agent swarm's system prompt and skills based strictly on the file types present in the Git diff.

1. Create a new branch for Phase 12.
2. Read the array of changed files produced by the `--diff` execution.
3. If the diff contains UI/frontend files (e.g., `page.tsx`, `layout.tsx`, `components/`):
   - Load and inject "React Architecture" and "Performance Auditor" instructions (e.g., checking for stale closures, prop drilling, unoptimized images).
4. If the diff contains backend/data files (e.g., `route.ts`, `schema.ts`, `prisma/`, `*.sql`):
   - Load and inject "Type Wizard" and "Security Auditor" instructions (e.g., catching `any` assertions, unvalidated Zod payloads, raw SQL queries).
5. If the diff contains configuration (e.g., `package.json`, `next.config.ts`):
   - Inject dependency and environment variable auditing instructions.
6. Construct the final system prompt by concatenating the base Scrutineer instructions with only the triggered specialized personas.
7. Verify `npm run typecheck`, `npm run build`, and `npm test` pass.
8. Push the branch and open a PR per the standard workflow.

## Phase 13: Diff-Hunk Line Validation (Issue #46, Step 2)

Issue #46 tracks replacing the aggregated PR comment with native GitHub inline review comments. Step 1 (structured findings) shipped in #48: the code-reviewer/security-auditor personas now return `file`/`line`/`severity`/`description` per finding via `generateObject`, instead of free text (`src/services/review-schema.ts`). Before a finding's `line` can anchor a GitHub Reviews API comment, it has to be validated against the diff's actual hunks — the API rejects a comment anchored to a line outside the diff.

1. Create a new branch for Phase 13.
2. Parse unified-diff hunk headers (`@@ -a,b +c,d @@`) in `git-diff.ts` (or a new `diff-hunks.ts`) into a per-file set of valid line numbers.
3. Validate each finding's `line` (from `ReviewResult.codeReview.review`/`securityAudit.review`) against that set. Define an explicit fallback for a finding whose line doesn't validate (e.g. drop to file-level, or exclude from inline eligibility and keep it in the review's top-level body) rather than letting a bad line fail the GitHub API call.
4. Add tests covering multi-hunk diffs, added vs. context lines, and an out-of-diff line number correctly failing validation.
5. Verify `npm run typecheck`, `npm run build`, and `npm test` pass.
6. Push the branch and open a PR per the standard workflow.

## Phase 14: `postPrReview()` Reviews API Client (Issue #46, Step 3)

The Reviews API (`POST /repos/{owner}/{repo}/pulls/{pr}/reviews`) is a different shape than today's single-comment `postPrComment()`: one `body` (overall summary) plus a `comments[]` array of `{ path, line, body }`, with its own submit semantics.

> **Superseded (see Phase 20).** Step 2's "alongside (not replacing) `postPrComment()`" was correct while both delivery paths were live. Phase 15 then switched `--pr` delivery entirely to `postPrReview()`, leaving `postPrComment()` with no caller in `src/` outside its own tests. Phase 20 removes it. Keep `postPrReview()` as the single delivery function; don't re-add a flat-comment path without a new reason to.

1. Create a new branch for Phase 14.
2. Add `postPrReview()` to `src/services/github-client.ts`, alongside (not replacing) `postPrComment()`.
3. Default `event` to `"COMMENT"` — scrutineer is advisory and should not auto-approve or auto-request-changes on a PR.
4. Mirror `postPrComment()`'s existing test coverage (request shape, response parsing, non-ok error handling) for the new function.
5. Verify `npm run typecheck`, `npm run build`, and `npm test` pass.
6. Push the branch and open a PR per the standard workflow.

## Phase 15: Inline Review CLI Wiring & Non-Per-Line Content Homing (Issue #46, Step 4)

Switches actual delivery from the aggregated comment to the inline review, using Phase 13's line validation and Phase 14's `postPrReview()`.

1. Create a new branch for Phase 15.
2. In `src/index.ts`'s `--pr` path, build a `comments[]` array from each validated finding (across both personas) and call `postPrReview()` instead of `postPrComment()`.
3. Home the report content that doesn't anchor to one line — the Sandbox Test section, verdict, and severity/summary counts — in the review's top-level `body`, as a short cover note above the per-line comments.
4. Verify `npm run typecheck`, `npm run build`, and `npm test` pass, and manually confirm against a real PR that inline comments land on the correct file/line and the cover note reads well.
5. Push the branch and open a PR per the standard workflow.

## Phase 16: Cross-Chunk Finding Dedup (Issue #46, Step 5)

`mergeChunkedReview()` in `ai-orchestrator.ts` currently just concatenates each chunk's findings — fine while everything funnels into one aggregated comment, less so once every finding becomes its own visible inline comment.

1. Create a new branch for Phase 16.
2. Add basic dedup logic to `mergeChunkedReview()` for near-identical findings across chunks (e.g. matching file + line + substantially similar description).
3. Add tests covering a genuine cross-chunk duplicate being merged, and distinct findings on the same file/line being kept separate.
4. Verify `npm run typecheck`, `npm run build`, and `npm test` pass.
5. Push the branch and open a PR per the standard workflow.

## Phases 17–21: Simplification Pass

Phases 1–16 grew the tool feature-by-feature under PR review, and the residue shows: `dist/` ships artifacts nothing can consume, comments outweigh code 37:100 in `src/`, `ai-orchestrator.ts` has reached 1,061 lines across six responsibilities, a few helpers outlived their callers, and `docs/ARCHITECTURE.md` last described reality around Phase 11. These five phases pay that down without changing behavior.

Ground rules for all five:

- **No test file is modified**, with one deliberate exception called out in Phase 20. If a change requires editing a test, it changed behavior — revert and reconsider. The 175-test suite is the proof that these phases are behavior-preserving.
- **One phase per branch/PR**, in order. 19 depends on 18 having cleared the comments it would otherwise relocate, and 21 documents the structure 19 and 20 leave behind — so it runs last, not first.

### Phase 17: Build Output Slimming

`tsconfig.build.json` inherits `declaration: true` and `sourceMap: true` from the base config and never sets `removeComments`, so `dist/` (320 KB) ships three things no consumer can use. Measured on the current build:

- **Comments: 49.3 KB of the 118.9 KB of emitted JS (41%).** `tsc` preserves them by default.
- **Sourcemaps: 69.1 KB that cannot resolve.** They reference `../../src/*.ts` with no `sourcesContent`, and `package.json`'s `files: ["dist"]` means `src/` is never published.
- **Declarations: 11.0 KB nothing can import.** `package.json` has `bin` only — no `main`, `exports`, or `types`.

Note this is a bin-only CLI, not a browser bundle: there is no per-pageview download cost and install size is dominated by `isolated-vm`/`ts-morph`/the AI SDKs regardless. Do this for a clean published artifact, not for a performance claim.

1. Create a new branch for Phase 17.
2. In `tsconfig.build.json` only — leaving `tsconfig.json` untouched so `npm run dev` and `npm run typecheck` keep full fidelity — set `removeComments: true`, `declaration: false`, and `sourceMap: false`.
3. Confirm `dist/index.js` is still executable (`chmod +x` runs as part of `npm run build`) and that `node dist/index.js --version` prints the version read from `package.json`.
4. Verify `npm run typecheck`, `npm run build`, and `npm test` pass, and record the before/after `dist/` size in the PR body.
5. Push the branch and open a PR per the standard workflow.

### Phase 18: Comment Cleanup

`src/` carries 718 comment lines against 1,938 code lines. 55% of them sit in 34 blocks of 8+ consecutive lines, and 43 blocks cite a PR or issue number. These are not "what" comments — they are minutes of PR review meetings written into the source: which reviewer caught which regression, what a constant used to be, what an earlier version of the very same comment got wrong. Git and GitHub already store that, and it crowds out the security rationale that genuinely needs to be read.

The target is code that is self-documenting by default, with comments reserved for what the code cannot say. Sort every comment into one of four buckets:

1. **Keep** — non-obvious "why" that nothing else records. The isolate double-dispose segfault guard (`sandbox.ts`), the `-`-prefixed git ref argument-injection guard (`git-diff.ts`), Ollama's `/api/ps` omitting `capabilities` (`model-factory.ts`), the `+++` file-header ambiguity (`diff-hunks.ts`), and the zero-width-space injection defense — the *rule*, not its revision history.
2. **Compress** — same rationale, stated once, roughly 15:1. `review-schema.ts`'s 27-line block at `neutralizeBlockStarts` becomes ~4 lines: GFM block-start markers in LLM-authored text can forge a heading out of a list item; a zero-width space defeats pattern-matching invisibly; setext underlines (`-`/`=`) need no minimum length unlike thematic breaks. Which PR caught it goes.
3. **Delete** — changelog prose ("Doubled from the pre-structured-output value of 4096"), comments correcting earlier versions of themselves, and the four `// Exported so <x>.test.ts can assert…` blocks, which explain nothing the `export` keyword doesn't.
4. **Defer to Phase 19** — comments that exist only because a symbol is in the wrong file. Leave them; Phase 19 deletes them by moving the code.

Target: ~718 → ~250 comment lines. `ast-parser.ts` (139 lines, zero comments) is the in-repo reference for the intended density.

1. Create a new branch for Phase 18.
2. Work file-by-file in descending comment density: `review-chunker.ts` (53%), `review-schema.ts` (40%), `ai-orchestrator.ts` (35%), `diff-hunks.ts` (30%), `skill-router.ts` (25%), `github-client.ts` (24%), `model-factory.ts` (22%), then the rest.
3. **Change no code in this phase** — not a rename, not a reorder. A pure comment diff keeps the PR reviewable at a glance and makes the passing suite meaningful evidence.
4. Verify `npm run typecheck`, `npm run build`, and `npm test` pass, and report the before/after comment-line count in the PR body.
5. Push the branch and open a PR per the standard workflow.

### Phase 19: Module Boundaries

`ai-orchestrator.ts` is 1,061 lines carrying six responsibilities: token budgeting, prompt assembly, provider quirks, concurrency, finding dedup, and markdown/HTML rendering. The last two are pure functions with no orchestration in them. Extracting them also deletes comments for free — a module named `markdown-safety.ts` states in its filename what a 27-line block currently argues in prose.

1. Create a new branch for Phase 19.
2. Extract `src/services/markdown-safety.ts`, consolidating the rendering/injection guards currently split across two files: `singleLine`, `neutralizeBlockStarts`, and `BLOCK_START_PATTERN` from `review-schema.ts`, plus `escapeHtml`, `neutralizeStructuralTags`, and `STRUCTURAL_TAG_PATTERN` from `ai-orchestrator.ts`.
3. De-duplicate `ZERO_WIDTH_SPACE`, currently defined identically in both `review-schema.ts` and `ai-orchestrator.ts` — `review-schema.ts`'s own comment already points at the other copy.
4. Extract `src/services/finding-dedup.ts`: `findingDedupeKey`, `descriptionWordSet`, `similarity`, `dedupeFindings`, and `DEDUPE_SIMILARITY_THRESHOLD`.
5. Fold the two near-identical `startSandboxTest` closures (one per pipeline, ~24 lines each including the same floating-promise `.catch`) into the existing `scheduleSandboxTest` seam, which already exists for exactly this purpose.
6. Leave `runReviewPipeline`'s and `runChunkedReviewPipeline`'s concurrency ordering alone. It is precisely regression-tested and is the highest-risk surface in these four phases — moving code out from around it is in scope; changing it is not.
7. Verify `npm run typecheck`, `npm run build`, and `npm test` pass — with no test file edited, including the import paths in existing tests if re-exports can preserve them.
8. Push the branch and open a PR per the standard workflow.

### Phase 20: API Surface Tidy & Docs Drift

Small helpers that outlived their callers, plus documentation still describing pre-Phase-15 behavior.

1. Create a new branch for Phase 20.
2. **Remove `postPrComment()`** and `PostPrCommentOptions`/`PostPrCommentResult` from `src/services/github-client.ts`, along with its tests in `github-client.test.ts`. Phase 15 moved `--pr` delivery to `postPrReview()`; nothing in `src/` has called it since. This is the one place in these four phases where a test file is deliberately deleted — removing a function's only remaining caller is the point, not a behavior change smuggled past the suite. Supersedes Phase 14's step 2.
3. Collapse `github-client.ts`'s three names for `{ url: string }` (`GitHubPostResult` plus two aliases) down to one now that only one write operation remains.
4. Replace `resolveInlineLocation` (`diff-hunks.ts`) with `resolveInlineLine(finding, hunkLines): number | undefined`. Its `FindingLocation.file` is an unmodified passthrough of `finding.file`, which every caller already holds.
5. Inline `exceedsMaxTotalFiles` (`review-chunker.ts`) at its single call site in `index.ts` — it wraps `files.length > MAX_TOTAL_FILES`.
6. Convert `runPersona`'s 8 positional parameters (`ai-orchestrator.ts`, 4 call sites) to a single options object so each call site is self-labeling.
7. Extract `resolveGithubTarget(options)` and the diff-vs-single-file context building out of the `review` command's ~230-line `.action()` handler in `index.ts`.
8. Leave all documentation alone — Phase 21 rewrites it in one pass, once the module structure has settled.
9. Verify `npm run typecheck`, `npm run build`, and `npm test` pass.
10. Push the branch and open a PR per the standard workflow.

### Phase 21: Architecture Doc Refresh

`docs/ARCHITECTURE.md` was last accurate around Phase 11. Everything since — dynamic skill routing (12), diff-hunk line validation (13), the Reviews API client (14), inline review delivery (15), cross-chunk dedup (16), and the chunked pipeline from issue #35 — is absent, and Phases 17–20 will have moved modules on top of that. Run this **last**, so the doc is written once against the final structure rather than three times against moving parts.

Verified drift to fix:

- **Three broken ADR links.** The doc points at `decisions/000{1,2,3}-*.md`; the files are in `docs/adr/`. All three 404.
- **Undocumented modules**: `review-chunker.ts`, `skill-router.ts`, `review-schema.ts`, `diff-hunks.ts`, `inline-review.ts`, plus whatever Phase 19 extracts (`markdown-safety.ts`, `finding-dedup.ts`).
- **Two false claims, both at the `--diff` bullet.** "filtered to `.ts`/`.tsx`" omits `isDynamicSkillTrigger`'s `package.json`/`next.config.*`/lockfile/`*.sql` handling and the lockfile `--stat` substitution. "**one** batch — one `runReviewPipeline` call covering every changed file" stopped being true above `MAX_FILES_PER_CHUNK` files.
- **Stale delivery description.** The `PR comment (--pr)` Mermaid node and the delivery bullet predate Phase 15 — `--pr` now posts a native GitHub review (cover-note body + per-line inline comments), not a flat issue comment. `README.md`'s usage comment says the same thing.
- **Free-text findings.** Section 3 describes personas producing prose; they return structured `PersonaReview` objects via `generateObject` against `personaReviewSchema`.

1. Create a new branch for Phase 21.
2. Fix the three ADR link paths (`decisions/` → `adr/`) and verify every relative link in the doc resolves.
3. Update the Mermaid flowchart to show the pipeline as it actually runs: the chunked path (`runChunkedReviewPipeline` when a batch exceeds `MAX_FILES_PER_CHUNK`, with `MAX_TOTAL_FILES` as the hard refusal ceiling), skill routing feeding the persona prompts, structured findings, hunk validation, and the inline-review delivery path.
4. Rewrite the `--diff` bullet's two false claims, and add coverage of the modules listed above.
5. Update `README.md`'s `--pr` usage comment to match.
6. Resolve the `dallaskoncir/scrutineer` vs `Flowlaps/scrutineer` inconsistency — `package.json`'s `repository`/`homepage`/`bugs` and the doc's issue links say the former; the git remote and this file's issue-tracker section say the latter. Confirm which is canonical before editing either.
7. Keep the existing voice: direct, concrete, no corporate register (per Phase 5's tone rule).
8. Verify every code reference in the doc still resolves against `src/` after Phases 17–20, and that `npm run typecheck`, `npm run build`, and `npm test` pass.
9. Push the branch and open a PR per the standard workflow.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (`flowlaps/scrutineer`), managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout — `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Agent Skills Policy
Use agent skills library selectively, keeping the context window focused:
- **Match the Skill to the Task**: Pick whichever installed skill best fits the work at hand rather than following a fixed branch-to-skill mapping.
- **Default to Installed Skills**: Before attempting to write custom scripts, scaffolding logic, or complex manual CLI commands, you MUST check for and utilize the installed skills from the Addy Osmani skill library.
- **Do Not Reinvent the Wheel**: If a task (like analyzing a repo, scaffolding a component, or managing git operations) can be accomplished using an existing installed skill, you are strictly required to invoke that skill rather than doing the work from scratch.

## Code Review Workflow
- **Strict Role Separation**: You act as my co-author (Claude) for writing code, committing, and opening PRs. However, the GitHub account `flowlaps-ai-reviewer` is strictly used as an independent reviewer.
- **Bot Token Usage**: When executing code reviews or posting review comments to a PR, you MUST authenticate using the `AI_BOT_GITHUB_TOKEN` environment variable so the feedback appears on GitHub as `flowlaps-ai-reviewer`. 
- **Subagent Pattern**: For a PR's *first* review, spawn a fresh, read-only subagent. The subagent must authenticate using `AI_BOT_GITHUB_TOKEN` to post its review to the GitHub PR. For a *re-review* of that same PR (e.g. after feedback was addressed), resume the same subagent instead of spawning a new one — a fresh agent has no memory of the first pass and re-derives context (re-reading files, re-looking-up the same documentation) it already gathered, instead of picking up where it left off.
- **Review Scope**: The reviewer subagent must check for security, edge cases, error handling, tests, complexity, and quality. It must NOT modify files during the review pass.

## Self-Correcting Memory
- Before exiting a session, write a brief, 1-sentence bullet point to `.claude/memory/corrections.md` documenting any architectural mistakes, syntax errors, or workflow violations you made that I had to manually correct.
- Always read `.claude/memory/corrections.md` at the start of every session to prevent repeating past mistakes.
