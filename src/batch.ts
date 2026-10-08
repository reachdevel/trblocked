import { check } from "./check.ts";
import { TargetError } from "./target.ts";
import { mapPool, Semaphore } from "./pool.ts";
import type { CheckResult, ConfigOverride, ProgressEvent, ReferenceProbe } from "./types.ts";

export type BatchEvent =
  | { type: "start"; index: number; target: string }
  | ({ index: number; target: string } & ProgressEvent)
  | { type: "done"; index: number; target: string; result: CheckResult };

export interface BatchOptions {
  /** Targets checked at the same time. Default 16. */
  concurrency?: number;
  config?: ConfigOverride;
  reference?: ReferenceProbe;
  onEvent?: (event: BatchEvent) => void;
}

const failed = (target: string, err: unknown): CheckResult => {
  const message = err instanceof Error ? err.message : String(err);
  return {
    target,
    host: target,
    blocked: false,
    status: "inconclusive",
    types: [],
    confidence: "low",
    evidence: { ips: [] },
    notes: [err instanceof TargetError ? { code: "target.invalid", params: { input: err.input } } : { code: "error.unexpected", params: { message } }],
    error: message,
  };
};

/**
 * Check many targets concurrently. Results keep input order; one bad target never fails the batch.
 * Throttle measurements are serialized (they compete for bandwidth) and reference lookups are capped
 * (to stay inside public API rate limits); everything else runs fully in parallel.
 */
export async function checkMany(inputs: readonly string[], opts: BatchOptions = {}): Promise<CheckResult[]> {
  const limits = { throttle: new Semaphore(1), reference: new Semaphore(3) };
  const emit = opts.onEvent ?? (() => {});
  return mapPool(inputs, opts.concurrency ?? 16, async (target, index) => {
    emit({ type: "start", index, target });
    let result: CheckResult;
    try {
      result = await check(target, opts.config, {
        reference: opts.reference,
        limits,
        onProgress: (e) => emit({ ...e, index, target }),
      });
    } catch (err) {
      result = failed(target, err);
    }
    emit({ type: "done", index, target, result });
    return result;
  });
}
