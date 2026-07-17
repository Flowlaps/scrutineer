# ADR-002: Sandbox generated tests with isolated-vm

## Status
Accepted

## Date
2026-07-16

## Context
The pipeline asks a model to generate a smoke test for the file under review, then needs to actually run it to turn "the model says this has a bug" into "here's a test that ran and failed." That generated code is untrusted: it's LLM output, and the file it's testing may itself contain injected content the model picked up on. Running it has to be safe by construction, not by hoping the generated code is well-behaved — including against a script that's simply buggy (infinite loop, runaway allocation) rather than adversarial.

## Decision
Run generated test code inside an ephemeral `isolated-vm` V8 isolate (`src/services/sandbox.ts`) per invocation, with a bounded memory limit (32MB default), an execution timeout (5s default), and no filesystem, network, or Node built-ins reachable from inside it — the isolate starts with nothing beyond bare JS globals, and the only thing added back is a `console` shim that forwards to arrays on the host side. Failures of every kind (syntax errors, thrown exceptions, failed assertions, timeouts, memory-limit kills) are captured into the result object instead of propagating to the caller.

## Alternatives Considered

### vm2
- Pros: was the standard choice for Node sandboxing for years.
- Cons: the project is archived with known, unpatched sandbox-escape CVEs.
- Rejected: unacceptable for a tool whose entire job is safely running untrusted, LLM-generated code.

### Node's built-in `vm` module
- Pros: no extra dependency.
- Cons: Node's own docs are explicit that `vm` is not a security boundary — sandboxed code shares the host's V8 heap and global objects and can escape it.
- Rejected: doesn't meet "whatever the test does, it can't touch your machine."

### Child process with OS-level resource limits (ulimit / cgroups)
- Pros: real OS-level isolation, language-agnostic.
- Cons: heavier to spin up per review; no first-class cross-platform way to bound memory the way `isolated-vm`'s `memoryLimit` does; more moving parts to wire up console capture and timeouts correctly.
- Rejected: `isolated-vm` gives comparable memory/time bounding with a much smaller, in-process footprint that fits a CLI tool that needs to spin this up on every `review` call.

### Skip sandboxed execution — just have the model describe expected behavior in prose
- Pros: no sandbox dependency or complexity at all.
- Cons: this is strictly weaker evidence. A model asserting "this looks buggy" and a test that actually ran and failed are not the same signal, and the latter is the entire value proposition of this pipeline stage.
- Rejected: would remove the reason this stage exists.

## Consequences
- A tripped memory limit disposes the isolate internally before `sandbox.ts`'s `finally` block runs; calling `dispose()` again on an already-disposed isolate crashes the host process, so the code guards on `isolate.isDisposed` first. This is specifically regression-tested in `sandbox.test.ts` — a real bug caught during review, not a hypothetical.
- No filesystem access means generated tests can't `import` the file under test. The test-generation prompt has to instruct the model to reimplement just the pure logic it needs, inline, and assert against that — which caps what kinds of bugs this stage can catch. Side-effecting or I/O-bound code can't be exercised this way; this stage is scoped to pure-logic smoke tests only.
- No network access rules out ever using this stage to hit a real or mocked API — that's a deliberate trade against the "zero network access" security requirement, not an oversight.
