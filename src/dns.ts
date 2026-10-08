import { Resolver, lookup } from "node:dns/promises";
import type { Config, DnsAnswer, DnsRcode, DnsVerdict } from "./types.ts";

const ERR_TO_RCODE: Record<string, DnsRcode> = {
  ENOTFOUND: "NXDOMAIN",
  ENODATA: "NOERROR", // name exists, no A records
  ESERVFAIL: "SERVFAIL",
  ETIMEOUT: "TIMEOUT",
  ECONNREFUSED: "TIMEOUT",
};

/** Plain DNS query against one specific server (UDP/TCP 53). */
export async function queryResolver(server: string | null, host: string, timeoutMs: number): Promise<DnsAnswer> {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  if (server) resolver.setServers([server]);
  try {
    return { source: server ?? "system", rcode: "NOERROR", addresses: await resolver.resolve4(host) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    return { source: server ?? "system", rcode: ERR_TO_RCODE[code] ?? "ERROR", addresses: [] };
  }
}

/** System resolver as the OS would use it for this process. */
export async function querySystem(host: string, timeoutMs: number): Promise<DnsAnswer> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const res = await Promise.race([
      lookup(host, { family: 4, all: true }),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), timeoutMs);
      }),
    ]);
    return { source: "system", rcode: "NOERROR", addresses: res.map((r) => r.address) };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "";
    return { source: "system", rcode: ERR_TO_RCODE[code] ?? "ERROR", addresses: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** DNS-over-HTTPS (JSON API). Endpoints are addressed by IP so no system DNS is involved. */
export async function queryDoh(name: string, url: string, host: string, timeoutMs: number): Promise<DnsAnswer> {
  try {
    const res = await fetch(`${url}?name=${encodeURIComponent(host)}&type=A`, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { source: name, rcode: "ERROR", addresses: [] };
    const body = (await res.json()) as { Status: number; Answer?: { type: number; data: string }[] };
    const addresses = (body.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
    const rcode: DnsRcode = body.Status === 0 ? "NOERROR" : body.Status === 3 ? "NXDOMAIN" : "SERVFAIL";
    return { source: name, rcode, addresses };
  } catch {
    return { source: name, rcode: "TIMEOUT", addresses: [] };
  }
}

const definitive = (a: DnsAnswer) => a.rcode === "NOERROR" || a.rcode === "NXDOMAIN";

/** Race a pool: first definitive answer wins; if none is definitive, return the last failure. */
export function firstDefinitive(probes: Promise<DnsAnswer>[], fallbackSource: string): Promise<DnsAnswer> {
  return new Promise((resolve) => {
    let pending = probes.length;
    if (pending === 0) return resolve({ source: fallbackSource, rcode: "ERROR", addresses: [] });
    let last: DnsAnswer = { source: fallbackSource, rcode: "TIMEOUT", addresses: [] };
    for (const p of probes) {
      p.then((a) => {
        if (definitive(a)) return resolve(a);
        last = a;
      }).finally(() => {
        if (--pending === 0) resolve(last);
      });
    }
  });
}

export function queryIspPool(cfg: Config, host: string): Promise<DnsAnswer> {
  return firstDefinitive(
    cfg.ispResolvers.map((s) => queryResolver(s, host, cfg.timeoutsMs.dns)),
    "isp",
  );
}

export function queryDohPool(cfg: Config, host: string): Promise<DnsAnswer> {
  return firstDefinitive(
    cfg.dohEndpoints.map((e) => queryDoh(e.name, e.url, host, cfg.timeoutsMs.dns)),
    "doh",
  );
}

export function isBogon(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/**
 * Decide whether `answer` (from a resolver under test) shows DNS blocking, using `truth` (DoH) as reference.
 * `verifyCert(ip)` is called only when answers differ and cannot be explained by block-page/bogon/NXDOMAIN
 * signals (CDNs legitimately return different IPs): it should report whether `ip` presents a valid
 * certificate for the host, or `undefined` if the handshake could not complete (e.g. SNI is blocked
 * there too), in which case no verdict is drawn.
 */
export async function judgeDns(
  answer: DnsAnswer,
  truth: DnsAnswer | undefined,
  cfg: Pick<Config, "blockPageIps">,
  verifyCert: (ip: string) => Promise<boolean | undefined>,
): Promise<DnsVerdict> {
  if (answer.rcode === "TIMEOUT" || answer.rcode === "ERROR" || answer.rcode === "SERVFAIL") {
    return { blocked: false, reason: "unknown" };
  }
  if (answer.addresses.some((ip) => cfg.blockPageIps.includes(ip))) return { blocked: true, reason: "blockpage-ip" };
  if (answer.addresses.some(isBogon)) return { blocked: true, reason: "bogon-ip" };

  const truthHasRecords = truth && truth.rcode === "NOERROR" && truth.addresses.length > 0;
  if (!truthHasRecords) return { blocked: false, reason: truth ? "none" : "unknown" };

  if (answer.rcode === "NXDOMAIN" || answer.addresses.length === 0) return { blocked: true, reason: "nxdomain" };
  if (answer.addresses.some((ip) => truth.addresses.includes(ip))) return { blocked: false, reason: "none" };

  const valid = await verifyCert(answer.addresses[0]!);
  if (valid === undefined) return { blocked: false, reason: "unknown" };
  return valid ? { blocked: false, reason: "none" } : { blocked: true, reason: "cert-mismatch" };
}
