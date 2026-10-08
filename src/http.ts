import http from "node:http";
import type { BlockSignature, Config, HttpResult } from "./types.ts";

const MAX_BODY = 64 * 1024;

export interface HttpResponseView {
  status?: number;
  location?: string;
  body: string;
}

/** Pure: does this response look like an ISP/BTK block page? Returns signature id and decision text. */
export function matchBlockPage(
  res: HttpResponseView,
  cfg: { signatures: BlockSignature[]; decisionPattern: string },
): { signature: string; decision?: string } | undefined {
  for (const sig of cfg.signatures) {
    const haystack = sig.where === "location" ? res.location : res.body;
    if (haystack && new RegExp(sig.pattern, "i").test(haystack)) {
      const m = new RegExp(cfg.decisionPattern, "i").exec(res.body);
      const decision = m?.[1]?.replace(/\s+/g, " ").trim();
      return { signature: sig.id, ...(decision ? { decision } : {}) };
    }
  }
  return undefined;
}

/** Plain-HTTP GET against `ip` with a chosen Host header; redirects are not followed. */
export function httpProbe(
  ip: string,
  port: number,
  host: string,
  path: string,
  cfg: Pick<Config, "http">,
  timeoutMs: number,
): Promise<HttpResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let done = false;
    const finish = (r: Omit<HttpResult, "ms">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve({ ...r, ms: Date.now() - start });
    };
    const req = http.request(
      { host: ip, port, path, method: "GET", headers: { Host: host, "User-Agent": "Mozilla/5.0 (trblocked)", Accept: "*/*", Connection: "close" } },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const complete = () => {
          const view: HttpResponseView = {
            status: res.statusCode,
            location: res.headers.location,
            body: Buffer.concat(chunks).toString("utf8"),
          };
          const blockPage = matchBlockPage(view, cfg.http);
          finish({ outcome: "ok", status: view.status, location: view.location, ...(blockPage ? { blockPage } : {}) });
        };
        res.on("data", (c: Buffer) => {
          chunks.push(c);
          size += c.length;
          if (size >= MAX_BODY) complete();
        });
        res.on("end", complete);
        res.on("error", (err: NodeJS.ErrnoException) => finish({ outcome: err.code === "ECONNRESET" ? "reset" : "error", code: err.code }));
      },
    );
    const timer = setTimeout(() => finish({ outcome: "timeout" }), timeoutMs);
    req.on("error", (err: NodeJS.ErrnoException) =>
      finish({ outcome: err.code === "ECONNRESET" ? "reset" : err.code === "ETIMEDOUT" ? "timeout" : "error", code: err.code }),
    );
    req.end();
  });
}
