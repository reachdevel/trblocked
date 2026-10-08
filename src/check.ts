import { getServers } from "node:dns";
import { resolveConfig } from "./config.ts";
import type { Semaphore } from "./pool.ts";
import { isBogon, judgeDns, queryDohPool, queryIspPool, querySystem } from "./dns.ts";
import { lookupHostsFile } from "./hosts.ts";
import { httpProbe } from "./http.ts";
import { createIpProber, resolvePorts } from "./ipprobe.ts";
import { measureThrottling } from "./throttle.ts";
import { tcpProbe } from "./tcp.ts";
import { parseTarget } from "./target.ts";
import { tlsProbe } from "./tls.ts";
import { analyzeHttp, analyzeTcp } from "./verdict.ts";
import type {
  BlockType,
  CheckResult,
  Confidence,
  ConfigOverride,
  DnsAnswer,
  DnsVerdict,
  IpEvidence,
  Note,
  ProgressEvent,
  ReferenceEndpoint,
  ReferenceProbe,
  Stage,
  Status,
  TlsResult,
} from "./types.ts";

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const minConfidence = (a: Confidence, b: Confidence): Confidence => (RANK[a] <= RANK[b] ? a : b);

const tlsBlockLike = (r?: TlsResult) => r?.outcome === "reset" || r?.outcome === "timeout";
const tlsAlive = (r?: TlsResult) => r?.outcome === "ok" || r?.outcome === "alert";

export interface CheckDeps {
  /** Optional outside vantage point. Sends the hostname to a third party, so it is opt-in. */
  reference?: ReferenceProbe;
  /** Progress callback: one `plan` event first, then start/end per stage. */
  onProgress?: (event: ProgressEvent) => void;
  /** Shared across concurrent checks (see checkMany) to keep measurements honest and APIs un-rate-limited. */
  limits?: { reference?: Semaphore; throttle?: Semaphore };
  /** Test seam: replace the DNS lookups (the real network is used for any that are not given). */
  dns?: { isp?: (host: string) => Promise<DnsAnswer>; system?: (host: string) => Promise<DnsAnswer>; truth?: (host: string) => Promise<DnsAnswer> };
}

export async function check(input: string, override: ConfigOverride = {}, deps: CheckDeps = {}): Promise<CheckResult> {
  const cfg = resolveConfig(override);
  const target = parseTarget(input, cfg.ports.tls);
  const notes: Note[] = [];
  const types = new Set<BlockType>();
  const confidences: Confidence[] = [];
  let decision: string | undefined;
  const result: CheckResult = {
    target: input,
    host: target.host,
    blocked: false,
    status: "inconclusive",
    types: [],
    confidence: "low",
    evidence: { ips: [] },
    notes,
  };

  // `http://` means the site is reached over plain HTTP: its primary port is the HTTP port and there is no TLS to test.
  // Without a scheme both are tested, and a missing 443 alone proves nothing (many servers only speak HTTP).
  const ports = resolvePorts(target, cfg);
  const { primary: primaryPort, http: httpPort, tls: tlsPort } = ports;

  const emit = deps.onProgress ?? (() => {});
  const stage = async <T>(name: Stage, fn: () => Promise<T>): Promise<T> => {
    emit({ type: "stage", stage: name, state: "start" });
    try {
      return await fn();
    } finally {
      emit({ type: "stage", stage: name, state: "end" });
    }
  };
  emit({
    type: "plan",
    stages: [
      ...(target.isIp ? [] : (["dns"] as const)),
      "connect",
      ...(deps.reference ? (["reference"] as const) : []),
      ...(cfg.throttle.enabled && !target.isIp ? (["throttle"] as const) : []),
    ],
  });

  // Control probe runs alongside DNS: without general connectivity every timeout would look like a block.
  const controlProbe = tcpProbe(cfg.controlTarget.host, cfg.controlTarget.port, cfg.timeoutsMs.tcp);

  // ---- per-IP probing (started as soon as the real IPs are known, overlapping the remaining DNS analysis) ----
  const probeIp = createIpProber(cfg, target, ports);
  const neutral = cfg.neutralHost;
  let ips: string[] = [];
  let connecting: Promise<IpEvidence[]> | undefined;
  const startConnect = () => {
    ips = ips.slice(0, cfg.maxIps);
    if (ips.length > 0) connecting = stage("connect", () => Promise.all(ips.map(probeIp)));
  };

  // ---- DNS ----
  if (target.isIp) {
    ips = [target.host];
    startConnect();
  } else {
    const lookups = {
      isp: deps.dns?.isp ?? ((h: string) => queryIspPool(cfg, h)),
      system: deps.dns?.system ?? ((h: string) => querySystem(h, cfg.timeoutsMs.dns)),
      truth: deps.dns?.truth ?? ((h: string) => queryDohPool(cfg, h)),
    };
    const nxdomain = await stage("dns", async (): Promise<boolean> => {
      const [isp, system, truth] = await Promise.all([lookups.isp(target.host), lookups.system(target.host), lookups.truth(target.host)]);

      // Real IPs come from DoH alone, so probing starts now; the judgments below (which may wait on a
      // certificate handshake) only produce notes and must not delay it.
      let truthNote: Note | undefined;
      let missing = false;
      if (truth.rcode === "NOERROR" && truth.addresses.length > 0) {
        ips = truth.addresses;
      } else if (truth.rcode === "NXDOMAIN") {
        truthNote = { code: "dns.hostMissing" };
        missing = true;
      } else if (truth.rcode === "NOERROR") {
        // The name exists but has no IPv4 address (IPv6-only?). Only IPv4 is tested, so there is nothing to probe.
        truthNote = { code: "dns.noARecord" };
        missing = true;
      } else {
        truthNote = { code: "dns.dohUnavailable" };
        ips = system.addresses.filter((ip) => !isBogon(ip) && !cfg.blockPageIps.includes(ip));
        confidences.push("low");
      }
      if (!missing) startConnect();

      const verifyCert = async (ip: string) => {
        const r = await tlsProbe(ip, tlsPort, target.host, cfg.timeoutsMs.tls);
        return r.outcome === "ok" ? r.authorized === true : undefined;
      };
      const [ispVerdict, systemVerdict]: DnsVerdict[] = await Promise.all([
        judgeDns(isp, truth, cfg, verifyCert),
        judgeDns(system, truth, cfg, verifyCert),
      ]);
      result.evidence.dns = { isp, system, truth, ispVerdict, systemVerdict };

      if (ispVerdict.blocked) {
        types.add("dns");
        confidences.push(ispVerdict.reason === "cert-mismatch" ? "medium" : "high");
        notes.push({ code: `dns.blocked.${ispVerdict.reason}` });
        const pageIp = isp.addresses.find((ip) => cfg.blockPageIps.includes(ip));
        if (pageIp) {
          // The block-page server answers only some requests, and for some blocks it answers with a redirect
          // instead of a decision page (or hardly at all): try a few times, then say what we could not get.
          let redirect: string | undefined;
          for (let attempt = 0; attempt < cfg.http.decisionAttempts && !decision && !redirect; attempt++) {
            const page = await httpProbe(pageIp, cfg.ports.http, target.host, "/", cfg, cfg.http.decisionTimeoutMs);
            decision = page.blockPage?.decision;
            if (page.blockPage && !decision) redirect = page.location;
          }
          if (!decision) notes.push(redirect ? { code: "dns.decisionRedirect", params: { url: redirect } } : { code: "dns.decisionUnavailable" });
        }
      }
      if (isp.rcode === "TIMEOUT" || isp.rcode === "ERROR") notes.push({ code: "dns.noIspAnswer" });
      if (truthNote) notes.push(truthNote);
      return missing;
    });
    if (nxdomain) {
      if (decision) result.decision = decision;
      return finalize(result, types, confidences, "inconclusive");
    }
  }

  const control = await controlProbe;
  if (control.outcome !== "ok") {
    notes.length = 0;
    notes.push({ code: "control.noConnectivity", params: { host: cfg.controlTarget.host, port: cfg.controlTarget.port, outcome: control.outcome } });
    return result;
  }

  if (!connecting) {
    notes.push({ code: "connect.noIps" });
    return finalize(result, types, confidences, "inconclusive");
  }
  result.evidence.ips = await connecting;

  const evs = result.evidence.ips;
  let ipConfidence: Confidence | undefined;
  let httpDropConfidence: Confidence | undefined;
  let httpDropOnly = false;

  const tcpVerdict = analyzeTcp(evs);
  if (tcpVerdict.ipBlock) {
    types.add("ip");
    ipConfidence = tcpVerdict.allReset ? "high" : "medium";
    notes.push({ code: tcpVerdict.allReset ? "tcp.reset" : "tcp.timeout" });
  } else if (tcpVerdict.deadCount > 0) {
    notes.push({ code: "tcp.partial", params: { blocked: tcpVerdict.deadCount, total: evs.length } });
  }
  if (tcpVerdict.primaryClosed) notes.push({ code: "tcp.primaryClosed", params: { port: primaryPort } });

  const sniBlocked = evs.filter((e) => tlsBlockLike(e.tlsRealSni) && tlsAlive(e.tlsAltSni));
  if (sniBlocked.length > 0) {
    types.add("sni");
    confidences.push("high");
    notes.push({ code: "tls.sni", params: { host: target.host, alt: neutral ?? "" } });
  }
  if (evs.some((e) => tlsBlockLike(e.tlsRealSni) && tlsBlockLike(e.tlsAltSni))) {
    notes.push({ code: "tls.anySni" });
  }

  // Plain HTTP: an injected block page is conclusive; a request that dies while a neutral Host is answered
  // on the same IP is a Host-based block (medium until an outside vantage point agrees).
  const { injectedHit: httpHit, dropHit } = analyzeHttp(evs);
  const injectedPage = httpHit?.http?.blockPage ?? httpHit?.httpRoot?.blockPage;
  if (httpHit && injectedPage) {
    types.add("http");
    confidences.push("high");
    decision ??= injectedPage.decision;
    notes.push({ code: "http.blockPage", params: { ip: httpHit.ip, signature: injectedPage.signature } });
  } else if (dropHit) {
    types.add("http");
    httpDropOnly = true;
    httpDropConfidence = "medium";
    notes.push({ code: "http.dropped", params: { ip: dropHit.ip, host: target.host, alt: neutral ?? "" } });
    if (dropHit.httpRoot) {
      notes.push(dropHit.httpRoot.outcome === "ok" && !dropHit.httpRoot.blockPage ? { code: "http.urlLevel", params: { path: target.path } } : { code: "http.hostLevel" });
    }
  }
  const injected = evs.filter((e) => e.injection);
  if (injected.length > 0) {
    const attempts = injected.reduce((n, e) => n + e.injection!.attempts, 0);
    const hits = injected.reduce((n, e) => n + e.injection!.hits, 0);
    notes.push(hits > 0 ? { code: "http.injection", params: { hits, attempts } } : { code: "http.injectionNone", params: { attempts } });
  }

  const anyAlive = evs.some((e) => tlsAlive(e.tlsRealSni) || (e.http?.outcome === "ok" && !e.http.blockPage));

  // Only ask the outside world when local evidence could be a plain outage or a server quirk (an IP block
  // by timeouts, a dropped Host) or is unexplained.
  const reference = deps.reference;
  if (reference) {
    await stage("reference", async () => {
      const unexplained = types.size === 0 && !anyAlive;
      if (!(types.has("ip") || httpDropOnly || unexplained)) return;
      const endpoints = new Map<string, ReferenceEndpoint>();
      const add = (protocol: ReferenceEndpoint["protocol"], port: number) => endpoints.set(`${protocol}:${port}`, { protocol, port });
      if (types.has("ip") || unexplained) {
        // Ask about the protocol(s) the user cares about; with no scheme given, either one answering proves it is up.
        if (target.scheme !== "https") add("HTTP", httpPort);
        if (target.scheme !== "http") add("HTTPS", tlsPort);
      }
      if (httpDropOnly) add("HTTP", httpPort);
      // Only host and "/" leave the machine: reachability is all we need, and a URL path can be sensitive.
      const ask = () => reference.probe({ host: target.host, path: "/", endpoints: [...endpoints.values()] });
      const ref = await (deps.limits?.reference ? deps.limits.reference.run(ask) : ask());
      result.evidence.reference = ref;
      if (ref.reachable === true) {
        notes.push({ code: "ref.reachable", params: { provider: ref.provider } });
        if (types.has("ip")) ipConfidence = "high";
        if (httpDropOnly) httpDropConfidence = "high";
      } else if (ref.reachable === false) {
        notes.push({ code: "ref.unreachable", params: { provider: ref.provider } });
        if (types.delete("ip")) ipConfidence = undefined;
        if (httpDropOnly) {
          types.delete("http");
          httpDropConfidence = undefined;
        }
      } else {
        notes.push({ code: "ref.inconclusive", params: { provider: ref.provider, detail: ref.detail } });
      }
    });
  }
  if (ipConfidence && types.has("ip")) confidences.push(ipConfidence);
  if (httpDropConfidence && types.has("http")) confidences.push(httpDropConfidence);

  // Throttling needs a working connection with the real SNI, so it runs on the first IP where that holds.
  if (cfg.throttle.enabled && !target.isIp) {
    await stage("throttle", async () => {
      const ev = evs.find((e) => e.tcp.outcome === "ok" && tlsAlive(e.tlsRealSni));
      if (!ev) return;
      // Concurrent downloads would eat each other's bandwidth, so batches serialize this stage.
      const measure = () => measureThrottling(ev.ip, tlsPort, target.host, target.path, cfg);
      const t = await (deps.limits?.throttle ? deps.limits.throttle.run(measure) : measure());
      result.evidence.throttle = t.evidence;
      const kb = (bps?: number) => (bps === undefined ? "?" : `${Math.round(bps / 1024)} KB/s`);
      const c = t.evidence.control;
      if (t.throttled) {
        types.add("throttle");
        confidences.push(t.confidence);
        notes.push({
          code: "throttle.detected",
          params: {
            real: kb(t.evidence.real.bytesPerSec),
            sni: t.evidence.workload.host,
            control: kb(c?.sample.bytesPerSec),
            target: c?.target ?? "",
            ratio: t.evidence.ratio?.toFixed(2) ?? "?",
          },
        });
      } else if (t.throttled === false) {
        notes.push({ code: "throttle.none", params: { real: kb(t.evidence.real.bytesPerSec), control: kb(c?.sample.bytesPerSec), ratio: t.evidence.ratio?.toFixed(2) ?? "?" } });
      } else if (t.evidence.reason) {
        notes.push({ code: "throttle.unjudged", params: { reason: t.evidence.reason } });
      }
    });
  }

  // About the user's own DNS, not about the host: always the last note.
  const dnsEv = result.evidence.dns;
  if (dnsEv?.systemVerdict?.blocked) {
    const hostsIp = lookupHostsFile(target.host);
    notes.push(hostsIp ? { code: "dns.system.hosts", params: { host: target.host, ip: hostsIp } } : { code: "dns.system.resolver", params: { servers: getServers().join(", ") } });
  } else if (dnsEv?.ispVerdict?.blocked) {
    notes.push({ code: "dns.system.clean", params: { servers: getServers().join(", ") } });
  }

  const status: Status = types.size > 0 ? "blocked" : anyAlive ? "accessible" : "inconclusive";
  if (status === "accessible") confidences.push("high");
  if (decision) result.decision = decision;
  return finalize(result, types, confidences, status);
}

function finalize(result: CheckResult, types: Set<BlockType>, confidences: Confidence[], status: Status): CheckResult {
  result.types = [...types];
  result.status = status;
  result.blocked = status === "blocked";
  result.confidence = status === "inconclusive" ? "low" : confidences.reduce(minConfidence, "high");
  return result;
}
