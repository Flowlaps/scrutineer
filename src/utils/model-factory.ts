import { anthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOllama } from "ollama-ai-provider-v2";
import type { LanguageModel } from "ai";

export type ProviderId = "anthropic" | "ollama" | "openai" | "gemini";

export const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "ollama", "openai", "gemini"];

const DEFAULT_MODEL_ID: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-5",
  ollama: "phi4",
  openai: "gpt-4o-mini",
  gemini: "gemini-flash-latest",
};

// Scoped per provider so an override set for one provider (e.g. a pinned Anthropic
// model) can't leak into another provider's model ID when --provider switches.
// Exported so the CLI's --help text can list these without duplicating the names.
export const MODEL_ENV_VAR: Record<ProviderId, string> = {
  anthropic: "SCRUTINEER_MODEL_ANTHROPIC",
  ollama: "SCRUTINEER_MODEL_OLLAMA",
  openai: "SCRUTINEER_MODEL_OPENAI",
  gemini: "SCRUTINEER_MODEL_GEMINI",
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
  capabilities?: string[];
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

// Ollama reports a `capabilities` array per model on /api/tags (and /api/show) —
// chat-capable models include "completion", embedding-only models (e.g.
// nomic-embed-text) don't. /api/ps (currently-running models) never reports this
// field at all, on any Ollama version, so a capability check against an /api/ps
// entry's own (always-absent) field would be a no-op — verified directly against
// a running instance's /api/ps output, not assumed. detectOllamaModelId() below
// cross-references /api/tags for capabilities instead. Picking an embedding model
// sends it a chat request it can't serve, which comes back as a bare "Bad Request"
// indistinguishable from any other failure until you inspect the response body —
// see GH #22, reproduced live against an instance where an embedding model
// happened to be the most recently loaded (i.e. /api/ps-listed) one. A model with
// no capabilities info available anywhere (older Ollama, or one missing from the
// /api/tags cross-reference) is treated as "unknown, assume usable" rather than
// excluded.
function isChatCapable(capabilities: string[] | undefined): boolean {
  return capabilities === undefined || capabilities.includes("completion");
}

// No explicit SCRUTINEER_MODEL_OLLAMA override: use whatever model the user actually
// has loaded (or, failing that, pulled) in their local Ollama instance instead of a
// hardcoded default that may not exist on their machine. Prefers a currently-running
// model (/api/ps) over merely-pulled ones (/api/tags) since that's what's already
// warm and avoids a cold-load delay on the first request.
async function detectOllamaModelId(): Promise<string> {
  const running = await fetchOllamaModels("/api/ps");
  let tags: OllamaModelSummary[] | undefined;

  if (running.length > 0) {
    // /api/ps entries never carry `capabilities` themselves (see comment on
    // isChatCapable), so resolve it by name against /api/tags, which does.
    tags = await fetchOllamaModels("/api/tags");
    const capabilitiesByModel = new Map(tags.map((m) => [m.model ?? m.name, m.capabilities]));
    const chatCapable = running.filter((m) => {
      const key = m.model ?? m.name;
      return isChatCapable(m.capabilities ?? (key ? capabilitiesByModel.get(key) : undefined));
    });
    const loaded = chatCapable[0]?.model ?? chatCapable[0]?.name;
    if (loaded) {
      return loaded;
    }
  }

  const pulled = (tags ?? (await fetchOllamaModels("/api/tags"))).filter((m) => isChatCapable(m.capabilities));
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
    case "openai": {
      const openai = createOpenAI();
      return openai(override ?? DEFAULT_MODEL_ID.openai);
    }
    case "gemini": {
      const google = createGoogleGenerativeAI();
      return google(override ?? DEFAULT_MODEL_ID.gemini);
    }
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
