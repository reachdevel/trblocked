export type BlockType = "dns" | "ip" | "sni" | "http" | "throttle";

/** Language-neutral message: rendered to text by the i18n layer. Param values may be nested Notes. */
export interface Note {
  code: string;
  params?: Record<string, string | number | Note>;
}

export type Status = "blocked" | "accessible" | "inconclusive";
export type Confidence = "high" | "medium" | "low";

export interface Config {
  ispResolvers: string[];
  dohEndpoints: { name: string; url: string }[];
  blockPageIps: string[];
  /** An unblocked, boring hostname used as the control: neutral SNI in TLS, neutral Host header in HTTP. */
  neutralHost: string;
  controlTarget: { host: string; port: number };
  ports: { tls: number; http: number };
  http: {
    signatures: BlockSignature[];
    decisionPattern: string;
    /** The block-page server drops or delays requests now and then: retry with a short timeout. */
    decisionAttempts: number;
    decisionTimeoutMs: number;
    /** Timeout for the neutral-Host / root-path control requests of the HTTP differential. */
    controlTimeoutMs: number;
    /** Opt-in: DPI injects its block page on only some plain-HTTP requests, so repeat the request and count. */
    injection: { enabled: boolean; attempts: number; timeoutMs: number };
  };
  /** `enabled` is only read by the CLI; check() never calls out unless a ReferenceProbe is passed. */
  reference: { enabled: boolean; globalping: GlobalpingConfig };
  throttle: ThrottleConfig;
  maxIps: number;
  timeoutsMs: { dns: number; tcp: number; tls: number; http: number };
}

export interface ThrottleConfig {
  /** Opt-in: downloads up to `maxBytes` several times per check. */
  enabled: boolean;
  maxBytes: number;
  maxWindowMs: number;
  /** A response that completes with fewer bytes than this is too small to judge throughput. */
  minBytes: number;
  /** Throttled when real throughput < ratio * control throughput. */
  ratio: number;
  /** If the control itself is slower than this, the connection is too slow to judge. */
  minControlBytesPerSec: number;
  /** Fallback fast download sources (full https URLs) when the target server rejects the SNI swap. */
  externalControls: string[];
}

type DeepPartial<T> = T extends unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/** User-supplied overrides: every key optional at every depth; plain objects merge, arrays are replaced. */
export type ConfigOverride = DeepPartial<Config>;

/** CLI-only preferences, stored under the `cli` key of a config file. */
export interface CliSettings {
  lang?: string;
  /** "auto" (default) detects; "unicode"/"ascii" force the symbol set and Turkish-letter handling. */
  charset?: "auto" | "unicode" | "ascii";
  /** Show environment warnings (VPN, hotspot). Default true. */
  warnings?: boolean;
}

export interface GlobalpingConfig {
  apiUrl: string;
  /** Globalping location objects, e.g. `{ "country": "DE", "limit": 1 }`. Each probe costs one credit. */
  locations: Record<string, unknown>[];
  timeoutMs: number;
  pollIntervalMs: number;
}

/** A vantage point outside the local network, used to tell "blocked here" from "down for everyone". */
export interface ReferenceEndpoint {
  protocol: "HTTP" | "HTTPS";
  port: number;
}

export interface ReferenceProbe {
  readonly name: string;
  /** Reachable if ANY endpoint answers. Must not throw: failures are reported as `reachable: undefined`. */
  probe(req: { host: string; path: string; endpoints: ReferenceEndpoint[] }): Promise<ReferenceResult>;
}

export interface ReferenceSample {
  location: string;
  ok: boolean;
  detail: string;
}

export interface ReferenceResult {
  provider: string;
  /** true: some outside vantage point got a response; false: none did; undefined: could not tell. */
  reachable: boolean | undefined;
  samples: ReferenceSample[];
  detail: string;
}

export interface BlockSignature {
  id: string;
  where: "body" | "location";
  /** Regular expression source, matched case-insensitively. */
  pattern: string;
}

export interface Target {
  host: string;
  isIp: boolean;
  /** Explicit port if given, else the default passed to parseTarget. */
  port: number;
  /** Set only when the input spelled a port out. */
  explicitPort?: number;
  /** Set only when the input had a scheme; `http` means "this site is reached over plain HTTP". */
  scheme?: "http" | "https";
  path: string;
}

export type DnsRcode = "NOERROR" | "NXDOMAIN" | "SERVFAIL" | "TIMEOUT" | "ERROR";

export interface DnsAnswer {
  source: string;
  rcode: DnsRcode;
  addresses: string[];
}

export type DnsReason = "nxdomain" | "blockpage-ip" | "bogon-ip" | "cert-mismatch" | "none" | "unknown";

export interface DnsVerdict {
  blocked: boolean;
  reason: DnsReason;
}

export type TcpOutcome = "ok" | "reset" | "timeout" | "refused" | "unreachable" | "error";
export type TlsOutcome = "ok" | "alert" | "reset" | "timeout" | "error";

export interface TcpResult {
  outcome: TcpOutcome;
  ms: number;
  code?: string;
}

export interface TlsResult {
  outcome: TlsOutcome;
  ms: number;
  authorized?: boolean;
  code?: string;
}

export interface HttpResult {
  outcome: "ok" | "reset" | "timeout" | "error";
  ms: number;
  status?: number;
  location?: string;
  code?: string;
  /** Set when the response matched a block-page signature. */
  blockPage?: { signature: string; decision?: string };
}

export interface ThroughputSample {
  outcome: "ok" | "reset" | "timeout" | "error";
  status?: number;
  location?: string;
  bytes: number;
  /** The server finished the response before maxBytes/maxWindowMs were reached. */
  complete: boolean;
  ttfbMs?: number;
  windowMs?: number;
  bytesPerSec?: number;
  code?: string;
}

export interface ThrottleEvidence {
  ip: string;
  workload: { host: string; path: string };
  real: ThroughputSample;
  control?: { kind: "same-ip-sni" | "external"; target: string; sample: ThroughputSample };
  ratio?: number;
  /** undefined = could not judge (see `reason`). */
  throttled?: boolean;
  reason?: Note;
}

export interface IpEvidence {
  ip: string;
  /** TCP to the primary port (443, or the explicit/HTTP port for http:// targets). */
  tcp: TcpResult;
  /** TCP to the plain-HTTP port when that is not the primary port. */
  tcpHttp?: TcpResult;
  tlsRealSni?: TlsResult;
  tlsAltSni?: TlsResult;
  http?: HttpResult;
  /** Escalation: same IP, neutral Host header, path "/" (only when the real Host got no answer). */
  httpAlt?: HttpResult;
  /** Escalation: real Host, path "/" (only for targets that have a path). */
  httpRoot?: HttpResult;
  injection?: { attempts: number; hits: number };
}

export type Stage = "dns" | "connect" | "reference" | "throttle";

export type ProgressEvent =
  | { type: "plan"; stages: Stage[] }
  | { type: "stage"; stage: Stage; state: "start" | "end" };

export interface CheckResult {
  target: string;
  host: string;
  /** Derived: status === "blocked". */
  blocked: boolean;
  status: Status;
  types: BlockType[];
  confidence: Confidence;
  /** Court decision text from the block page, when one was seen. */
  decision?: string;
  /** Set when the target could not be checked at all (e.g. invalid input). */
  error?: string;
  evidence: {
    dns?: {
      isp?: DnsAnswer;
      system?: DnsAnswer;
      truth?: DnsAnswer;
      ispVerdict?: DnsVerdict;
      systemVerdict?: DnsVerdict;
    };
    ips: IpEvidence[];
    reference?: ReferenceResult;
    throttle?: ThrottleEvidence;
  };
  notes: Note[];
  /** Environment warnings (VPN, hotspot...) attached by the caller, not by check(). */
  warnings?: Note[];
}
