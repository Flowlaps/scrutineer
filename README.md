# scrutineer

Scrutineer is a CLI that reviews the TypeScript files in your merge/pull request before you merge, one file at a time. For each file, it extracts real AST context, hands that context to a code-reviewer and then a security-auditor agent in sequence, and sandboxes an AI-generated smoke test so you get a signal on behavior, not just prose — and it can post the resulting report straight back to the PR.

## Architecture Highlights

- **AST extraction — `ts-morph`.** Before anything gets sent to a model, `src/services/ast-parser.ts` parses the target file with `ts-morph` and pulls out exported function signatures, imports, and interfaces into a compact Markdown/JSON summary. The model reviews structured facts about the file, not just a raw diff.
- **Provider-agnostic model factory — Vercel AI SDK.** `src/utils/model-factory.ts` wraps both Anthropic (via `@ai-sdk/anthropic`) and a local Ollama model (via `ollama-ai-provider-v2`) behind one `createModel(provider)` call. Everything downstream — the review pipeline, the test generator — just gets a `LanguageModel` and doesn't care which provider produced it. This is what lets the whole pipeline run fully air-gapped against a local model when that's a requirement.
- **Secure sandboxing — `isolated-vm`.** The same model is also asked to write a small self-contained smoke test for the file — this only depends on the AST context and diff, so it runs in parallel with the review passes rather than waiting on them. That test runs inside an ephemeral V8 isolate (`src/services/sandbox.ts`) with a bounded memory limit, an execution timeout, and zero filesystem, network, or Node built-in access. Whatever the test does, it can't touch your machine — and a script that blows past its memory or time budget gets its failure captured and reported, not left to crash the process.
- **Diffs get scrubbed before they leave your machine.** `src/services/secret-scrubber.ts` redacts anything that looks like an API key, token, or private key block out of the diff before it's included in a prompt.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full data flow, and [`docs/decisions/`](docs/decisions/) for the reasoning and rejected alternatives behind these choices.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Run the CLI from source with `tsx` (no build step) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled CLI from `dist/` |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Run the test suite (`node --test`) |

## Installation & Setup

Install from npm:

```bash
npm install -g @flowlaps/scrutineer
```

Or run it straight from the registry without installing:

```bash
npx @flowlaps/scrutineer review ./src/index.ts
```

(The commands below use `scrutineer` for brevity, assuming a global install. If you're using `npx @flowlaps/scrutineer` instead, swap that in wherever you see `scrutineer`.)

To work on the CLI itself, build from source instead:

```bash
git clone https://github.com/dallaskoncir/scrutineer.git
cd scrutineer
npm install
npm run build
```

Copy `.env.example` to `.env` and fill in what you need:

```bash
cp .env.example .env
```

```
ANTHROPIC_API_KEY=sk-ant-...

# Only needed for `scrutineer review --pr <number>`
GITHUB_TOKEN=
```

You only need `ANTHROPIC_API_KEY` if you're using the default `anthropic` provider. If you want to run fully offline against a local model instead:

```bash
# Install Ollama: https://ollama.com/download
ollama pull qwen2.5-coder:7b
```

Make sure the Ollama server is running (`ollama serve`, or it's already running as a background service) before using `--provider ollama`.

Optional overrides, if you want a specific model instead of the defaults (`claude-sonnet-5` for Anthropic, `qwen2.5-coder:7b` for Ollama):

```
SCRUTINEER_MODEL_ANTHROPIC=claude-opus-4-8
SCRUTINEER_MODEL_OLLAMA=llama3.1:8b
```

`GITHUB_TOKEN` is only needed if you want `scrutineer review` to post its report as a PR comment (see below) — a personal access token with permission to comment on the repo's PRs is enough.

## Usage

Run the full review pipeline (code review → security audit, with a sandboxed smoke test generated and executed in parallel) against a file. With no flags, it prints a step-by-step progress UI and the final report to your terminal:

```bash
scrutineer review ./src/index.ts
```

Run it against a local model instead of Anthropic's API:

```bash
scrutineer review ./src/index.ts --provider ollama
```

Write the report to a file, post it as a comment on a PR, or both — they're independent flags:

```bash
scrutineer review ./src/index.ts --output review.md
scrutineer review ./src/index.ts --pr 42
scrutineer review ./src/index.ts --output review.md --pr 42
```

`--pr` needs `GITHUB_TOKEN` set and infers the repo from your `origin` remote (override with `--repo owner/repo` if that's wrong).

You can also run just the AST extraction on its own, without calling any model:

```bash
scrutineer parse ./src/index.ts
scrutineer parse ./src/index.ts --json
```

> Scrutineer reviews one file at a time — for a whole MR, run it once per changed file (pair with `--pr` to post each file's report as a separate comment on the same PR). There's no recursive directory scan or single-command whole-diff review yet.
