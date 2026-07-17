# ADR-003: Pin and hash-verify upstream persona prompts

## Status
Accepted

## Date
2026-07-16

## Context
The `code-reviewer` and `security-auditor` system prompts aren't maintained in this codebase — they're fetched at runtime from Addy Osmani's [`agent-skills`](https://github.com/addyosmani/agent-skills) repository, so the personas benefit from upstream improvements without duplicating that maintenance work here. But fetching prompt content from a third party over the network, and feeding it directly into the system prompt of a model that reviews the user's source code, is a real supply-chain and prompt-injection surface: if that content can change out from under us, so can the reviewer's behavior, silently.

## Decision
Pin `AGENT_SKILLS_COMMIT` to a specific commit SHA in `src/services/prompt-loader.ts` and fetch persona files only from that pinned commit's raw content path. Verify the SHA-256 of the content against a hardcoded `EXPECTED_SHA256` before using it — on every load, whether the content came from the network or from the on-disk cache (24h TTL, cache dir and files locked to `0700`/`0600` permissions). A hash mismatch on a cache read triggers a silent refetch rather than a hard failure; a mismatch on a fresh fetch throws, refusing to proceed with unverified content.

## Alternatives Considered

### Vendor the persona markdown files directly into this repo
- Pros: no runtime network dependency at all; works fully offline; no hash-pinning machinery needed.
- Cons: loses the "pick up vetted upstream improvements" benefit — and updating still requires a manual sync step either way, so this doesn't actually save effort over bumping a pinned commit SHA.
- Rejected: pinning-plus-hash keeps the upstream relationship visible and the update step just as deliberate, for about the same amount of code.

### Fetch from upstream's default branch, unpinned
- Pros: always picks up the latest persona content automatically.
- Cons: a force-push, a compromised upstream maintainer account, or a bad edit on the default branch changes this tool's review behavior with zero review or approval on our side — for a tool whose entire job is being trusted with a user's source code.
- Rejected: unacceptable supply-chain exposure for the benefit of not having to bump a SHA occasionally.

### Pin the commit, skip hash verification
- Pros: simpler — one less constant to maintain.
- Cons: a commit SHA pin alone doesn't fully close the gap — rewritten history plus a compromised/coerced account, a MITM'd fetch, or a tampered local cache entry could still substitute content at that pinned path, and pinning alone gives no protection against a poisoned on-disk cache.
- Rejected: the hash check is what makes the pin actually mean something, and it needs to run on cache reads too, not just network fetches — otherwise a poisoned cache entry would be trusted silently on every run within the 24h TTL.

## Consequences
- Adopting a newer upstream persona revision is a deliberate two-constant change (commit SHA + expected hash), not a one-line URL edit — that friction is intentional.
- A hash mismatch on a cached file (stale-TTL race, disk corruption, tampering) degrades to a refetch rather than failing the whole review outright, so transient cache issues don't block a run.
- This protects prompt *integrity* (the content is exactly what we pinned and reviewed), not prompt *quality* — if a future pinned commit itself contains weak or wrong review guidance, this mechanism will faithfully use it. It guards against corruption and tampering, not against upstream regressions in judgment.
