import { httpProbe } from "./http.ts";
import { tcpProbe } from "./tcp.ts";
import { tlsProbe } from "./tls.ts";
import type { Config, HttpResult, IpEvidence, Target } from "./types.ts";
import { httpDead } from "./verdict.ts";

export interface Ports {
  /** `http://` means plain HTTP is the site's own protocol: its primary port is the HTTP port and TLS is not tested. */
  httpOnly: boolean;
  primary: number;
  http: number;
  tls: number;
}

/**
 * Without a scheme both 443 and 80 are tested (a missing 443 alone proves nothing: many servers only speak HTTP).
 * An explicit port in the URL applies to the protocol the scheme names.
 */
export function resolvePorts(target: Target, cfg: Pick<Config, "ports">): Ports {
  const httpOnly = target.scheme === "http";
  const primary = target.explicitPort ?? (httpOnly ? cfg.ports.http : cfg.ports.tls);
  return { httpOnly, primary, http: httpOnly ? primary : cfg.ports.http, tls: httpOnly ? cfg.ports.tls : primary };
}

/** Everything that touches the network for one IP; judging the evidence is verdict.ts / check.ts. */
export function createIpProber(cfg: Config, target: Target, ports: Ports): (ip: string) => Promise<IpEvidence> {
  const { httpOnly, primary: primaryPort, http: httpPort, tls: tlsPort } = ports;
  const sniHost = target.isIp ? undefined : target.host;
  const neutral = cfg.neutralHost;

  /** DPI answers only some plain-HTTP requests with its block page: repeat and count (opt-in, `--injection`). */
  const injectionRounds = async (ip: string) => {
    const { attempts, timeoutMs } = cfg.http.injection;
    let hits = 0;
    let first: HttpResult | undefined;
    for (let done = 0; done < attempts; done += 4) {
      const wave = await Promise.all(
        Array.from({ length: Math.min(4, attempts - done) }, () => httpProbe(ip, httpPort, target.host, target.path, cfg, timeoutMs)),
      );
      for (const r of wave) {
        if (r.blockPage) {
          hits++;
          first ??= r;
        }
      }
    }
    return { attempts, hits, first };
  };

  return async (ip: string): Promise<IpEvidence> => {
    // Plain HTTP runs beside the whole TCP -> TLS chain (not before it): DPI often injects the block
    // page there regardless of what happens on 443, and its timeout must not delay the TLS tests.
    const httpProbing = sniHost ? httpProbe(ip, httpPort, sniHost, target.path, cfg, cfg.timeoutsMs.http) : undefined;
    const tcpHttpProbing = httpOnly ? undefined : tcpProbe(ip, httpPort, cfg.timeoutsMs.tcp);
    const tcp = await tcpProbe(ip, primaryPort, cfg.timeoutsMs.tcp);
    const ev: IpEvidence = { ip, tcp };
    if (tcp.outcome === "ok" && !httpOnly) {
      // The neutral-SNI handshake runs alongside the real one instead of after its (slow) timeout.
      const [real, alt] = await Promise.all([
        tlsProbe(ip, tlsPort, sniHost, cfg.timeoutsMs.tls),
        sniHost && neutral ? tlsProbe(ip, tlsPort, neutral, cfg.timeoutsMs.tls) : undefined,
      ]);
      ev.tlsRealSni = real;
      if (alt) ev.tlsAltSni = alt;
    }
    const tcpHttp = await tcpHttpProbing;
    if (tcpHttp) ev.tcpHttp = tcpHttp;

    let http = await httpProbing;
    if (http && sniHost) {
      const httpPortOpen = httpOnly ? tcp.outcome === "ok" : tcpHttp?.outcome === "ok";
      // Escalation: the real Host got no answer although the port is open. Ask the same IP with a neutral
      // Host (and, for a URL with a path, the real Host for "/") to tell a Host/URL block from a dead server.
      if (httpPortOpen && !http.blockPage && httpDead(http) && neutral) {
        const [alt, root] = await Promise.all([
          httpProbe(ip, httpPort, neutral, "/", cfg, cfg.http.controlTimeoutMs),
          target.path !== "/" ? httpProbe(ip, httpPort, sniHost, "/", cfg, cfg.http.controlTimeoutMs) : undefined,
        ]);
        ev.httpAlt = alt;
        if (root) ev.httpRoot = root;
      }
      if (cfg.http.injection.enabled && httpPortOpen) {
        const inj = await injectionRounds(ip);
        ev.injection = { attempts: inj.attempts, hits: inj.hits };
        if (inj.first && !http.blockPage) http = inj.first;
      }
    }
    if (http) ev.http = http;
    return ev;
  };
}
