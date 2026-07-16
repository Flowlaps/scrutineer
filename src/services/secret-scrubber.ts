const SECRET_PATTERNS: RegExp[] = [
  // AWS access key IDs
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Common vendor token prefixes (OpenAI/Anthropic-style, Slack, GitHub, Stripe)
  /\b(?:sk|pk)-[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  // PEM private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // Generic `key`/`secret`/`token`/`password` assignments with a long opaque value
  /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9\-_/+=]{16,}["']?/gi,
];

export interface ScrubResult {
  scrubbed: string;
  redactedCount: number;
}

export function scrubSecrets(content: string): ScrubResult {
  let redactedCount = 0;
  let scrubbed = content;
  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, () => {
      redactedCount += 1;
      return "[REDACTED]";
    });
  }
  return { scrubbed, redactedCount };
}
