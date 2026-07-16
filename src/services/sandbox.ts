import ivm from "isolated-vm";

export interface SandboxOptions {
  memoryLimitMb?: number;
  timeoutMs?: number;
}

export interface SandboxResult {
  ok: boolean;
  logs: string[];
  errors: string[];
}

const DEFAULT_MEMORY_LIMIT_MB = 32;
const DEFAULT_TIMEOUT_MS = 5000;

function stringifyArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Runs untrusted JavaScript in an ephemeral V8 isolate with a bounded memory
 * limit and no filesystem, network, or Node built-ins — the isolate starts
 * with nothing beyond bare JS globals, and we only add a console shim that
 * forwards to the arrays returned here. Never throws: sandbox failures
 * (syntax errors, thrown exceptions, timeouts, memory-limit kills) are
 * captured into `errors` instead of propagating to the caller.
 */
export async function runInSandbox(
  code: string,
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  const memoryLimit = options.memoryLimitMb ?? DEFAULT_MEMORY_LIMIT_MB;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const logs: string[] = [];
  const errors: string[] = [];

  const isolate = new ivm.Isolate({ memoryLimit });
  try {
    const context = await isolate.createContext();
    const jail = context.global;
    await jail.set("global", jail.derefInto());

    await jail.set("_log", (...args: unknown[]) => {
      logs.push(args.map(stringifyArg).join(" "));
    });
    await jail.set("_error", (...args: unknown[]) => {
      errors.push(args.map(stringifyArg).join(" "));
    });

    await context.evalClosure(
      `
      global.console = {
        log: (...args) => _log(...args),
        info: (...args) => _log(...args),
        warn: (...args) => _log(...args),
        error: (...args) => _error(...args),
        assert: (condition, ...args) => {
          if (!condition) _error("Assertion failed:", ...args);
        },
      };
      `,
      [],
      { timeout },
    );

    const script = await isolate.compileScript(code);
    await script.run(context, { timeout });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
  } finally {
    // A tripped memory limit disposes the isolate internally before this
    // finally runs; disposing it again throws (and has been observed to
    // segfault the host process), so guard on isDisposed first.
    if (!isolate.isDisposed) {
      isolate.dispose();
    }
  }

  return { ok: errors.length === 0, logs, errors };
}
