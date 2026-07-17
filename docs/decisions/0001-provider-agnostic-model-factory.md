# ADR-001: Provider-agnostic model factory via the Vercel AI SDK

## Status
Accepted

## Date
2026-07-16

## Context
The review pipeline (`code-reviewer` → `security-auditor` → test generation) needs to call an LLM three times per run. Two requirements shaped how:
- It has to work against Anthropic's hosted API by default, for review quality.
- It also has to be able to run against a fully local model (Ollama), with zero network calls to a third-party API, for environments where source code can't leave the box at all.
- The orchestration code (`ai-orchestrator.ts`) shouldn't need to know or care which provider is active — provider selection is a `--provider` CLI flag, and that shouldn't ripple into every call site.

## Decision
Wrap both providers behind a single `createModel(provider: ProviderId): LanguageModel` factory (`src/utils/model-factory.ts`), using the Vercel AI SDK's `@ai-sdk/anthropic` and `ollama-ai-provider-v2` packages. Both return the same `LanguageModel` type, so `generateText()` calls in the orchestrator never branch on provider. Per-provider model IDs are overridable via scoped env vars (`SLIPSTREAM_MODEL_ANTHROPIC`, `SLIPSTREAM_MODEL_OLLAMA`) so an override for one provider can't leak into the other when `--provider` switches.

## Alternatives Considered

### Anthropic-only, no local option
- Pros: simplest possible implementation, one less dependency.
- Cons: no offline/air-gapped story at all.
- Rejected: air-gapped operation is a hard requirement, not a nice-to-have — this is a tool that reads and reviews source code, and some users can't send that off-box to any third-party API.

### LangChain's model abstraction
- Pros: batteries-included, large ecosystem, more providers supported out of the box.
- Cons: heavier dependency surface; brings its own message/tool/output types that would leak into the rest of the codebase for a use case that's currently three straight `generateText` calls.
- Rejected: more abstraction than the problem needs right now.

### Hand-rolled fetch wrappers per provider
- Pros: zero extra dependencies.
- Cons: reimplements token-usage reporting, streaming, and prompt-caching provider options that the Vercel AI SDK already exposes; loses the shared `LanguageModel` type that keeps the orchestrator provider-agnostic.
- Rejected: not worth the maintenance burden for what the SDK already provides.

## Consequences
- Orchestration code (`ai-orchestrator.ts`) never branches on which provider is active; only `model-factory.ts` and the prompt-caching helper (`cacheControlProviderOptions`, since caching is Anthropic-only) are provider-aware.
- Adding a third provider means one new branch in `createModel` plus one entry each in `DEFAULT_MODEL_ID` and `MODEL_ENV_VAR` — no changes to the pipeline itself.
- Provider-specific capabilities (like Anthropic prompt caching — see [ADR context in `docs/ARCHITECTURE.md`](../ARCHITECTURE.md)) still require explicit per-provider checks, since the SDK's shared `LanguageModel` interface doesn't abstract away every provider feature.
