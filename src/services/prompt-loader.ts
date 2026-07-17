import { mkdir, readFile, writeFile, stat, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

export type PersonaId = "code-reviewer" | "security-auditor";

export interface PersonaPrompt {
  id: PersonaId;
  name: string;
  description: string;
  systemPrompt: string;
}

// Pinned to a specific commit so persona content can't change out from under us —
// bump this deliberately (and the hashes below) when picking up an upstream update.
const AGENT_SKILLS_COMMIT = "c9ab1507a3cab6e1a61a975554e14f2a0d131c09";
const AGENT_SKILLS_RAW_BASE = `https://raw.githubusercontent.com/addyosmani/agent-skills/${AGENT_SKILLS_COMMIT}/agents`;

// SHA-256 of the pinned commit's persona files. Checked on every load, whether the
// content came from the network or the local cache, so a compromised upstream file
// or a planted cache entry is rejected instead of silently trusted.
const EXPECTED_SHA256: Record<PersonaId, string> = {
  "code-reviewer": "74667b052cb6a75079791cee8f6e465a248e28fd82178505aaaec8db95c40ccf",
  "security-auditor": "66a3f68f1c691b600ddb44e88afb138e239d0572df37be84e1f9a427c887dd0a",
};

const CACHE_DIR = path.join(os.tmpdir(), "scrutineer-agent-skills");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function verifyIntegrity(id: PersonaId, raw: string): void {
  const actual = createHash("sha256").update(raw, "utf-8").digest("hex");
  const expected = EXPECTED_SHA256[id];
  if (actual !== expected) {
    throw new Error(
      `Persona "${id}" content hash mismatch (expected ${expected}, got ${actual}). ` +
        "Refusing to use unverified persona content — if this is an intentional " +
        "upstream update, bump AGENT_SKILLS_COMMIT and EXPECTED_SHA256 in prompt-loader.ts.",
    );
  }
}

function parsePersonaMarkdown(id: PersonaId, raw: string): PersonaPrompt {
  const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    throw new Error(`Persona "${id}" is missing YAML frontmatter`);
  }
  const frontmatter = frontmatterMatch[1] ?? "";
  const body = frontmatterMatch[2] ?? "";
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const descriptionMatch = frontmatter.match(/^description:\s*(.+)$/m);
  const name = nameMatch?.[1];
  const description = descriptionMatch?.[1];
  if (!name || !description) {
    throw new Error(`Persona "${id}" frontmatter is missing name or description`);
  }

  return {
    id,
    name: name.trim(),
    description: description.trim(),
    systemPrompt: body.trim(),
  };
}

async function readCache(id: PersonaId): Promise<string | undefined> {
  const cachePath = path.join(CACHE_DIR, `${id}.md`);
  try {
    const stats = await stat(cachePath);
    if (Date.now() - stats.mtimeMs > CACHE_TTL_MS) {
      return undefined;
    }
    return await readFile(cachePath, "utf-8");
  } catch {
    return undefined;
  }
}

async function writeCache(id: PersonaId, raw: string): Promise<void> {
  // `mode` on mkdir/writeFile is only honored when the path is newly created — it's
  // silently ignored for a pre-existing dir/file (e.g. left over from before this
  // permission tightening). Explicit chmod guarantees the invariant either way.
  await mkdir(CACHE_DIR, { recursive: true });
  await chmod(CACHE_DIR, 0o700);
  const cachePath = path.join(CACHE_DIR, `${id}.md`);
  await writeFile(cachePath, raw, "utf-8");
  await chmod(cachePath, 0o600);
}

async function fetchPersonaMarkdown(id: PersonaId): Promise<string> {
  const url = `${AGENT_SKILLS_RAW_BASE}/${id}.md`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch persona "${id}" from ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

export async function loadPersonaPrompt(id: PersonaId): Promise<PersonaPrompt> {
  const cached = await readCache(id);
  if (cached) {
    try {
      verifyIntegrity(id, cached);
      return parsePersonaMarkdown(id, cached);
    } catch {
      // Cached content doesn't match the pinned hash — could be a stale TTL race,
      // corruption, or a planted file in the shared temp dir. Don't trust it; refetch.
    }
  }

  const raw = await fetchPersonaMarkdown(id);
  verifyIntegrity(id, raw);
  await writeCache(id, raw);
  return parsePersonaMarkdown(id, raw);
}
