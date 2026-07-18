import { anthropic } from "@ai-sdk/anthropic";
import { createOllama } from "ollama-ai-provider-v2";
import type { LanguageModel } from "ai";

export type ProviderId = "anthropic" | "ollama";

export const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "ollama"];

const DEFAULT_MODEL_ID: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-5",
  ollama: "phi4",
};

// Scoped per provider so an override set for one provider (e.g. a pinned Anthropic
// model) can't leak into another provider's model ID when --provider switches.
// Exported so the CLI's --help text can list these without duplicating the names.
export const MODEL_ENV_VAR: Record<ProviderId, string> = {
  anthropic: "SCRUTINEER_MODEL_ANTHROPIC",
  ollama: "SCRUTINEER_MODEL_OLLAMA",
};

const DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Respects OLLAMA_HOST the same way the official `ollama` CLI does, so scrutineer
// talks to whatever server the user already pointed their tooling at (e.g. a Windows
// Ollama install reached from WSL via its gateway IP) instead of always assuming a
// local instance on 127.0.0.1 — which may be a *different*, incidental Ollama server.
function resolveOllamaBaseUrl(): string {
  const host = process.env.OLLAMA_HOST?.trim();
  if (!host) {
    return DEFAULT_OLLAMA_HOST;
  }
  const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;
  return withScheme.replace(/\/+$/, "");
}

interface OllamaModelSummary {
  model?: string;
  name?: string;
}

const OLLAMA_DETECTION_TIMEOUT_MS = 2_000;

async function fetchOllamaModels(path: string): Promise<OllamaModelSummary[]> {
  try {
    const response = await fetch(`${resolveOllamaBaseUrl()}${path}`, {
      signal: AbortSignal.timeout(OLLAMA_DETECTION_TIMEOUT_MS),
    });
    if (!response.ok) {
      return [];
    }
    const data = (await response.json()) as { models?: OllamaModelSummary[] };
    return data.models ?? [];
  } catch {
    return [];
  }
}

// No explicit SCRUTINEER_MODEL_OLLAMA override: use whatever model the user actually
// has loaded (or, failing that, pulled) in their local Ollama instance instead of a
// hardcoded default that may not exist on their machine. Prefers a currently-running
// model (/api/ps) over merely-pulled ones (/api/tags) since that's what's already
// warm and avoids a cold-load delay on the first request.
async function detectOllamaModelId(): Promise<string> {
  const running = await fetchOllamaModels("/api/ps");
  const loaded = running[0]?.model ?? running[0]?.name;
  if (loaded) {
    return loaded;
  }

  const pulled = await fetchOllamaModels("/api/tags");
  const available = pulled[0]?.model ?? pulled[0]?.name;
  if (available) {
    return available;
  }

  return DEFAULT_MODEL_ID.ollama;
}

export async function createModel(provider: ProviderId): Promise<LanguageModel> {
  const override = process.env[MODEL_ENV_VAR[provider]];

  switch (provider) {
    case "anthropic":
      return anthropic(override ?? DEFAULT_MODEL_ID.anthropic);
    case "ollama": {
      const baseUrl = resolveOllamaBaseUrl();
      if (!isLoopbackUrl(baseUrl)) {
        console.error(
          `scrutineer: OLLAMA_HOST is set — sending review content (code diffs, AST context) to ${baseUrl} instead of the local default. Make sure you trust this endpoint.`,
        );
      }
      const ollama = createOllama({ baseURL: `${baseUrl}/api` });
      return ollama(override ?? (await detectOllamaModelId()));
    }
  }
}

// LanguageModel is a union that also allows a bare provider:model-id string, so
// `.modelId` isn't accessible without narrowing that case out first.
export function getModelId(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}
