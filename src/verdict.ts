import type { HttpResult, IpEvidence, TcpResult } from "./types.ts";

/** A closed port answers "refused", which is not blocking; silence or a reset is. */
export const tcpDead = (r?: TcpResult) => r?.outcome === "reset" || r?.outcome === "timeout";
export const httpDead = (r?: HttpResult) => r?.outcome === "reset" || r?.outcome === "timeout";

export interface TcpAnalysis {
  /** Every probed port of every IP is silent or reset. */
  ipBlock: boolean;
  allReset: boolean;
  /** IPs that are dead on every probed port. */
  deadCount: number;
  /** Some IP is dead on the primary port but answers on the plain-HTTP port. */
  primaryClosed: boolean;
}

/**
 * An IP-level block (null route, IP filter) kills every port. A dead 443 next to a working 80 only says
 * the server does not serve HTTPS (or filters per protocol): that is not an IP block.
 */
export function analyzeTcp(evs: IpEvidence[]): TcpAnalysis {
  const dead = evs.filter((e) => tcpDead(e.tcp) && (e.tcpHttp === undefined || tcpDead(e.tcpHttp)));
  return {
    ipBlock: evs.length > 0 && dead.length === evs.length,
    allReset: dead.every((e) => [e.tcp, e.tcpHttp].every((r) => r === undefined || r.outcome === "reset")),
    deadCount: dead.length,
    primaryClosed: evs.some((e) => tcpDead(e.tcp) && e.tcpHttp !== undefined && !tcpDead(e.tcpHttp)),
  };
}

export interface HttpAnalysis {
  /** An IP whose plain-HTTP answer was an injected block page. */
  injectedHit?: IpEvidence;
  /** An IP where the real Host got no answer while a neutral Host did (Host-based drop/reset). */
  dropHit?: IpEvidence;
}

export function analyzeHttp(evs: IpEvidence[]): HttpAnalysis {
  // The escalation request for "/" can be the one the middlebox answers, so it counts as well.
  const injectedHit = evs.find((e) => e.http?.blockPage || e.httpRoot?.blockPage);
  if (injectedHit) return { injectedHit };
  return { dropHit: evs.find((e) => httpDead(e.http) && e.httpAlt?.outcome === "ok") };
}
