import { anthropic } from "@ai-sdk/anthropic";
import { ollama } from "ollama-ai-provider-v2";
import type { LanguageModel } from "ai";

export type ProviderId = "anthropic" | "ollama";

export const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "ollama"];

const DEFAULT_MODEL_ID: Record<ProviderId, string> = {
  anthropic: "claude-sonnet-5",
  ollama: "qwen2.5-coder:7b",
};

// Scoped per provider so an override set for one provider (e.g. a pinned Anthropic
// model) can't leak into another provider's model ID when --provider switches.
const MODEL_ENV_VAR: Record<ProviderId, string> = {
  anthropic: "SCRUTINEER_MODEL_ANTHROPIC",
  ollama: "SCRUTINEER_MODEL_OLLAMA",
};

export function createModel(provider: ProviderId): LanguageModel {
  const modelId = process.env[MODEL_ENV_VAR[provider]] ?? DEFAULT_MODEL_ID[provider];

  switch (provider) {
    case "anthropic":
      return anthropic(modelId);
    case "ollama":
      return ollama(modelId);
  }
}
