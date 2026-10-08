import { loadDefaultConfig } from "../config.ts";
import type { GlobalpingConfig, ReferenceEndpoint, ReferenceProbe, ReferenceResult, ReferenceSample } from "../types.ts";

export interface GlobalpingOptions extends Partial<GlobalpingConfig> {
  /** Optional API token (raises rate limits). Never read from config files. */
  token?: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

interface Measurement {
  status: string;
  results?: {
    probe: { country?: string; city?: string; network?: string };
    result: { status: string; statusCode?: number | null; rawOutput?: string };
  }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reachability from public Globalping probes (https://globalping.io) via its REST API.
 * Works unauthenticated within the free rate limit; each probe consumes one credit.
 */
export class GlobalpingProbe implements ReferenceProbe {
  readonly name = "globalping";
  private readonly cfg: GlobalpingConfig;
  private readonly token?: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: GlobalpingOptions = {}) {
    const { token, fetch: f, ...overrides } = opts;
    this.cfg = { ...loadDefaultConfig().reference.globalping, ...overrides };
    this.token = token;
    this.fetchFn = f ?? fetch;
  }

  async probe(req: { host: string; path: string; endpoints: ReferenceEndpoint[] }): Promise<ReferenceResult> {
    // One measurement per endpoint (Globalping tests a single protocol/port at a time); any answer proves it is up.
    const results = await Promise.all(req.endpoints.map((e) => this.measure(req.host, req.path, e)));
    if (results.length === 0) return this.unknown("no endpoints to test");
    const samples = results.flatMap((r) => r.samples);
    const reachable = results.some((r) => r.reachable === true) ? true : results.every((r) => r.reachable === false) ? false : undefined;
    const detail = results.length === 1 ? results[0]!.detail : results.map((r, i) => `${req.endpoints[i]!.protocol}: ${r.detail}`).join("; ");
    return { provider: this.name, reachable, samples, detail };
  }

  private async measure(host: string, path: string, endpoint: ReferenceEndpoint): Promise<ReferenceResult> {
    try {
      const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "trblocked" };
      if (this.token) headers.authorization = `Bearer ${this.token}`;

      const created = await this.fetchFn(`${this.cfg.apiUrl}/measurements`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "http",
          target: host,
          locations: this.cfg.locations,
          measurementOptions: { protocol: endpoint.protocol, port: endpoint.port, request: { method: "HEAD", path } },
        }),
      });
      if (created.status === 429) return this.unknown("rate limited by Globalping");
      if (!created.ok) return this.unknown(`Globalping returned HTTP ${created.status} when creating the measurement`);
      const { id } = (await created.json()) as { id: string };

      const deadline = Date.now() + this.cfg.timeoutMs;
      for (;;) {
        const res = await this.fetchFn(`${this.cfg.apiUrl}/measurements/${id}`, { headers });
        if (!res.ok) return this.unknown(`Globalping returned HTTP ${res.status} when fetching results`);
        const m = (await res.json()) as Measurement;
        if (m.status !== "in-progress") return this.summarize(m, endpoint);
        if (Date.now() + this.cfg.pollIntervalMs > deadline) return this.unknown("timed out waiting for Globalping results");
        await sleep(this.cfg.pollIntervalMs);
      }
    } catch (err) {
      return this.unknown(err instanceof Error ? err.message : String(err));
    }
  }

  private summarize(m: Measurement, endpoint: ReferenceEndpoint): ReferenceResult {
    const samples: ReferenceSample[] = (m.results ?? []).map(({ probe, result }) => {
      const where = [probe.country, probe.city, probe.network].filter(Boolean).join("/") + ` ${endpoint.protocol}:${endpoint.port}`;
      // Any HTTP response (even 403/503) proves the host answers from there.
      const ok = result.status === "finished" && typeof result.statusCode === "number";
      const detail = ok ? `HTTP ${result.statusCode}` : (result.rawOutput ?? result.status).split("\n")[0]!.slice(0, 120);
      return { location: where, ok, detail };
    });
    if (samples.length === 0) return this.unknown("no Globalping probes were available for the requested locations");
    const reachable = samples.some((s) => s.ok);
    return {
      provider: this.name,
      reachable,
      samples,
      detail: `${samples.filter((s) => s.ok).length}/${samples.length} outside probes got a response`,
    };
  }

  private unknown(detail: string): ReferenceResult {
    return { provider: this.name, reachable: undefined, samples: [], detail };
  }
}
