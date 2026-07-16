# slipstream

Slipstream is a CLI that runs a small swarm of AI agents against a TypeScript file to review it before you merge. It extracts real AST context from the file, hands that context to a code-reviewer and then a security-auditor agent in sequence, and sandboxes an AI-generated smoke test so you get a signal on behavior, not just prose.

## Architecture Highlights

- **AST extraction — `ts-morph`.** Before anything gets sent to a model, `src/services/ast-parser.ts` parses the target file with `ts-morph` and pulls out exported function signatures, imports, and interfaces into a compact Markdown/JSON summary. The model reviews structured facts about the file, not just a raw diff.
- **Provider-agnostic model factory — Vercel AI SDK.** `src/utils/model-factory.ts` wraps both Anthropic (via `@ai-sdk/anthropic`) and a local Ollama model (via `ollama-ai-provider-v2`) behind one `createModel(provider)` call. Everything downstream — the review pipeline, the test generator — just gets a `LanguageModel` and doesn't care which provider produced it. This is what lets the whole pipeline run fully air-gapped against a local model when that's a requirement.
- **Secure sandboxing — `isolated-vm`.** After the review passes, the same model is asked to write a small self-contained smoke test for the file. That test runs inside an ephemeral V8 isolate (`src/services/sandbox.ts`) with a bounded memory limit, an execution timeout, and zero filesystem, network, or Node built-in access. Whatever the test does, it can't touch your machine — and a script that blows past its memory or time budget gets its failure captured and reported, not left to crash the process.
- **Diffs get scrubbed before they leave your machine.** `src/services/secret-scrubber.ts` redacts anything that looks like an API key, token, or private key block out of the diff before it's included in a prompt.

## Installation & Setup

```bash
git clone https://github.com/dallaskoncir/slipstream.git
cd slipstream
npm install
npm run build
```

Copy `.env.example` to `.env` and fill in what you need:

```bash
cp .env.example .env
```

```
ANTHROPIC_API_KEY=sk-ant-...
```

You only need `ANTHROPIC_API_KEY` if you're using the default `anthropic` provider. If you want to run fully offline against a local model instead:

```bash
# Install Ollama: https://ollama.com/download
ollama pull qwen2.5-coder:7b
```

Make sure the Ollama server is running (`ollama serve`, or it's already running as a background service) before using `--provider ollama`.

Optional overrides, if you want a specific model instead of the defaults (`claude-sonnet-5` for Anthropic, `qwen2.5-coder:7b` for Ollama):

```
SLIPSTREAM_MODEL_ANTHROPIC=claude-opus-4-8
SLIPSTREAM_MODEL_OLLAMA=llama3.1:8b
```

## Usage

Run the AI review pipeline (code review → security audit → sandboxed smoke test) against a file:

```bash
npx slipstream review ./src/index.ts
```

Run it against a local model instead of Anthropic's API:

```bash
npx slipstream review ./src/index.ts --provider ollama
```

You can also run just the AST extraction on its own, without calling any model:

```bash
npx slipstream parse ./src/index.ts
npx slipstream parse ./src/index.ts --json
```

> Slipstream currently reviews one file at a time — there's no recursive directory scan yet.
