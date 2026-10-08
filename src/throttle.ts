import { throughputProbe } from "./throughput.ts";
import type { Config, Confidence, Note, ThroughputSample, ThrottleEvidence } from "./types.ts";

export interface ThrottleResult {
  throttled: boolean | undefined;
  confidence: Confidence;
  evidence: ThrottleEvidence;
}

const isRedirect = (s: ThroughputSample) => s.status !== undefined && s.status >= 300 && s.status < 400 && !!s.location;

/** A sample can be compared only if it succeeded and is either still-running at the cut-off or big enough. */
function unusableReason(s: ThroughputSample, minBytes: number): Note | undefined {
  if (s.outcome !== "ok") return { code: "throttle.reason.request", params: { outcome: s.outcome, detail: s.code ?? "" } };
  if (s.status === undefined || s.status < 200 || s.status >= 300) return { code: "throttle.reason.http", params: { status: s.status ?? 0 } };
  if (s.complete && s.bytes < minBytes) return { code: "throttle.reason.small", params: { bytes: s.bytes } };
  if (s.bytesPerSec === undefined) return { code: "throttle.reason.window" };
  return undefined;
}

/**
 * Differential throughput test against one IP.
 * Control 1 (same server): identical Host/path, but a neutral SNI — only the SNI DPI sees changes.
 * Control 2 (fallback, lower confidence): a fast external source from config.
 */
export async function measureThrottling(
  ip: string,
  port: number,
  host: string,
  path: string,
  cfg: Pick<Config, "throttle" | "neutralHost" | "timeoutsMs">,
): Promise<ThrottleResult> {
  const t = cfg.throttle;
  const common = { maxBytes: t.maxBytes, maxWindowMs: t.maxWindowMs, connectTimeoutMs: cfg.timeoutsMs.tls };
  const measureReal = (w: { host: string; path: string }) =>
    throughputProbe({ connectHost: ip, port, sni: w.host, host: w.host, path: w.path, ...common });

  // Follow a few same-IP redirects (e.g. / -> /en) so we measure a real payload, not a 301.
  let workload = { host, path };
  let real = await measureReal(workload);
  for (let i = 0; i < 3 && isRedirect(real); i++) {
    try {
      const u = new URL(real.location!, `https://${workload.host}${workload.path}`);
      if (u.protocol !== "https:" || (u.port && Number(u.port) !== port)) break;
      workload = { host: u.hostname, path: u.pathname + u.search };
    } catch {
      break;
    }
    real = await measureReal(workload);
  }

  const evidence: ThrottleEvidence = { ip, workload, real };
  const fail = (reason: Note): ThrottleResult => ({ throttled: undefined, confidence: "low", evidence: { ...evidence, reason } });

  const realProblem = unusableReason(real, t.minBytes);
  if (realProblem) return fail(realProblem);

  const candidates: { kind: "same-ip-sni" | "external"; target: string; run: () => Promise<ThroughputSample> }[] = [];
  const alt = cfg.neutralHost;
  if (alt) {
    candidates.push({
      kind: "same-ip-sni",
      target: `${ip} with SNI ${alt}`,
      run: () => throughputProbe({ connectHost: ip, port, sni: alt, host: workload.host, path: workload.path, ...common }),
    });
  }
  for (const url of t.externalControls) {
    const u = new URL(url);
    candidates.push({
      kind: "external",
      target: url,
      run: () => throughputProbe({ connectHost: u.hostname, port: Number(u.port) || 443, host: u.host, path: u.pathname + u.search, ...common }),
    });
  }

  let control: ThrottleEvidence["control"];
  for (const c of candidates) {
    const sample = await c.run();
    if (!unusableReason(sample, t.minBytes)) {
      control = { kind: c.kind, target: c.target, sample };
      break;
    }
  }
  if (!control) return fail({ code: "throttle.reason.noControl" });
  evidence.control = control;

  const realBps = real.bytesPerSec!;
  const controlBps = control.sample.bytesPerSec!;
  if (controlBps < t.minControlBytesPerSec) {
    return fail({ code: "throttle.reason.slowControl", params: { bps: Math.round(controlBps) } });
  }
  evidence.ratio = realBps / controlBps;
  let throttled = evidence.ratio < t.ratio;

  // A dip can be noise: confirm once before calling it throttling.
  if (throttled) {
    const again = await measureReal(workload);
    if (unusableReason(again, t.minBytes) || again.bytesPerSec! / controlBps >= t.ratio) throttled = false;
    else evidence.ratio = Math.max(evidence.ratio, again.bytesPerSec! / controlBps);
  }
  evidence.throttled = throttled;
  return { throttled, confidence: control.kind === "same-ip-sni" ? "high" : "medium", evidence };
}
