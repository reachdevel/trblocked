import https from "node:https";
import type { ThroughputSample } from "./types.ts";

const MIN_WINDOW_MS = 50;

export interface ThroughputRequest {
  /** IP or hostname to connect to. */
  connectHost: string;
  port: number;
  /** TLS SNI to present; undefined = default (hostname connectHost) / none (IP). */
  sni?: string;
  /** HTTP Host header. */
  host: string;
  path: string;
  maxBytes: number;
  maxWindowMs: number;
  /** Limit for connect + TLS + response headers + first body byte. */
  connectTimeoutMs: number;
}

/**
 * Download over HTTPS and measure body throughput, excluding connect/TLS/first-chunk time.
 * Stops at `maxBytes` or `maxWindowMs` after the first body byte, whichever comes first.
 * Certificates are not verified: we only care how fast bytes flow, and SNI swaps would never validate.
 */
export function throughputProbe(req: ThroughputRequest): Promise<ThroughputSample> {
  return new Promise((resolve) => {
    const start = Date.now();
    let status: number | undefined;
    let location: string | undefined;
    let bytes = 0;
    let firstAt = 0;
    let firstLen = 0;
    let lastAt = 0;
    let done = false;
    let connectTimer: NodeJS.Timeout | undefined;
    let windowTimer: NodeJS.Timeout | undefined;

    const finish = (outcome: ThroughputSample["outcome"], complete: boolean, endAt: number, code?: string) => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      clearTimeout(windowTimer);
      r.destroy();
      const windowMs = firstAt ? endAt - firstAt : undefined;
      // Windows under MIN_WINDOW_MS (a fast link filling maxBytes at once) are clamped, so the rate is a
      // lower bound. That errs toward "not throttled", never toward a false alarm.
      const bytesPerSec = windowMs !== undefined && bytes > firstLen ? ((bytes - firstLen) / Math.max(windowMs, MIN_WINDOW_MS)) * 1000 : undefined;
      resolve({
        outcome,
        status,
        location,
        bytes,
        complete,
        ...(firstAt ? { ttfbMs: firstAt - start, windowMs } : {}),
        ...(bytesPerSec !== undefined ? { bytesPerSec } : {}),
        ...(code ? { code } : {}),
      });
    };

    const r = https.request({
      host: req.connectHost,
      port: req.port,
      path: req.path,
      method: "GET",
      servername: req.sni,
      headers: { Host: req.host, "Accept-Encoding": "identity", "User-Agent": "Mozilla/5.0 (trblocked)", Accept: "*/*", Connection: "close" },
      rejectUnauthorized: false,
      agent: false,
    });
    connectTimer = setTimeout(() => finish("timeout", false, Date.now()), req.connectTimeoutMs);
    r.on("error", (err: NodeJS.ErrnoException) =>
      finish(err.code === "ECONNRESET" ? "reset" : err.code === "ETIMEDOUT" ? "timeout" : "error", false, lastAt || Date.now(), err.code),
    );
    r.on("response", (res) => {
      status = res.statusCode;
      location = res.headers.location;
      res.on("data", (chunk: Buffer) => {
        const now = Date.now();
        if (!firstAt) {
          firstAt = now;
          firstLen = chunk.length;
          clearTimeout(connectTimer);
          windowTimer = setTimeout(() => finish("ok", false, Date.now()), req.maxWindowMs);
        }
        bytes += chunk.length;
        lastAt = now;
        if (bytes >= req.maxBytes) finish("ok", false, now);
      });
      res.on("end", () => finish("ok", true, lastAt || Date.now()));
      res.on("error", (err: NodeJS.ErrnoException) => finish(err.code === "ECONNRESET" ? "reset" : "error", false, lastAt || Date.now(), err.code));
    });
    r.end();
  });
}
