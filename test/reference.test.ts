import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { check } from "../src/check.ts";
import { GlobalpingProbe } from "../src/reference/globalping.ts";
import type { ReferenceProbe, ReferenceResult } from "../src/types.ts";

const HTTPS = [{ protocol: "HTTPS" as const, port: 443 }];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const probeOf = (results: { status: string; statusCode?: number; rawOutput?: string }[], extra: object[] = []) => {
  let polls = 0;
  const calls: { url: string; body?: string }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body as string | undefined });
    if (init?.method === "POST") return json({ id: "m1" }, 202);
    return json(++polls < 2 ? { status: "in-progress", results: [] } : {
      status: "finished",
      results: results.map((result, i) => ({ probe: { country: i ? "US" : "DE", network: "net" }, result })),
      ...Object.assign({}, ...extra),
    });
  }) as unknown as typeof fetch;
  return { calls, probe: new GlobalpingProbe({ fetch: fetchFn, pollIntervalMs: 5 }) };
};

test("Globalping: any HTTP response (even 403) means reachable", async () => {
  const { probe, calls } = probeOf([{ status: "finished", statusCode: 403 }, { status: "failed", rawOutput: "connect ETIMEDOUT" }]);
  const r = await probe.probe({ host: "example.com", path: "/", endpoints: HTTPS });
  assert.equal(r.reachable, true);
  assert.deepEqual(r.samples.map((s) => s.ok), [true, false]);
  const sent = JSON.parse(calls[0]!.body!);
  assert.equal(sent.type, "http");
  assert.equal(sent.target, "example.com");
  assert.equal(sent.measurementOptions.protocol, "HTTPS");
  assert.ok(calls.length >= 3, "polled until finished");
});

test("Globalping: one measurement per endpoint, any endpoint answering means reachable (HTTP-only hosts)", async () => {
  const bodies: { protocol: string; port: number }[] = [];
  let n = 0;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const o = JSON.parse(init.body as string).measurementOptions;
      bodies.push({ protocol: o.protocol, port: o.port });
      return json({ id: `m${++n}-${o.protocol}` }, 202);
    }
    const https = url.endsWith("-HTTPS");
    return json({ status: "finished", results: [{ probe: { country: "DE", network: "x" }, result: https ? { status: "failed", rawOutput: "ECONNREFUSED" } : { status: "finished", statusCode: 404 } }] });
  }) as unknown as typeof fetch;
  const r = await new GlobalpingProbe({ fetch: fetchFn, pollIntervalMs: 1 }).probe({
    host: "http-only.example", path: "/", endpoints: [{ protocol: "HTTPS", port: 443 }, { protocol: "HTTP", port: 80 }],
  });
  assert.deepEqual(bodies.map((b) => `${b.protocol}:${b.port}`).sort(), ["HTTP:80", "HTTPS:443"]);
  assert.equal(r.reachable, true); // a 404 over HTTP proves the host is up even though HTTPS is refused
  assert.deepEqual(r.samples.map((s) => s.ok).sort(), [false, true]);
  assert.ok(r.samples.some((s) => s.location.includes("HTTP:80")));
});

test("Globalping: all probes failing means unreachable", async () => {
  const { probe } = probeOf([{ status: "failed", rawOutput: "ETIMEDOUT" }, { status: "failed", rawOutput: "ECONNRESET" }]);
  const r = await probe.probe({ host: "x.test", path: "/", endpoints: HTTPS });
  assert.equal(r.reachable, false);
  assert.equal(r.samples[1]?.detail, "ECONNRESET");
});

test("Globalping: rate limit and network errors are 'unknown', never thrown", async () => {
  const limited = new GlobalpingProbe({ fetch: (async () => json({}, 429)) as unknown as typeof fetch });
  assert.equal((await limited.probe({ host: "a.test", path: "/", endpoints: HTTPS })).reachable, undefined);
  const broken = new GlobalpingProbe({ fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
  const r = await broken.probe({ host: "a.test", path: "/", endpoints: HTTPS });
  assert.equal(r.reachable, undefined);
  assert.match(r.detail, /offline/);
});

test("Globalping: gives up when the measurement never finishes", async () => {
  const stuck = new GlobalpingProbe({
    timeoutMs: 30,
    pollIntervalMs: 10,
    fetch: (async (_u: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ id: "m" }, 202) : json({ status: "in-progress" })) as unknown as typeof fetch,
  });
  const r = await stuck.probe({ host: "a.test", path: "/", endpoints: HTTPS });
  assert.equal(r.reachable, undefined);
  assert.match(r.detail, /timed out/);
});

// check() + reference, fully offline: a local server stands in for the control target,
// and 192.0.2.1 (TEST-NET-1) is a black hole.
async function withBlackhole(reachable: boolean | undefined) {
  const control = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
  const { port } = control.address() as net.AddressInfo;
  const reference: ReferenceProbe = {
    name: "fake",
    probe: async (): Promise<ReferenceResult> => ({ provider: "fake", reachable, samples: [], detail: "fake" }),
  };
  try {
    return await check(
      "192.0.2.1",
      { controlTarget: { host: "127.0.0.1", port }, timeoutsMs: { dns: 500, tcp: 400, tls: 400, http: 400 } },
      { reference },
    );
  } finally {
    control.close();
  }
}

test("check: IP timeout + reachable from outside -> ip block with high confidence", async (t) => {
  const r = await withBlackhole(true);
  if (r.evidence.ips[0]?.tcp.outcome !== "timeout") return t.skip("network does not black-hole TEST-NET-1");
  assert.deepEqual(r.types, ["ip"]);
  assert.equal(r.status, "blocked");
  assert.equal(r.confidence, "high");
  assert.equal(r.evidence.reference?.reachable, true);
});

test("check: IP timeout + unreachable from outside -> not a block (host is down)", async (t) => {
  const r = await withBlackhole(false);
  if (r.evidence.ips[0]?.tcp.outcome !== "timeout") return t.skip("network does not black-hole TEST-NET-1");
  assert.deepEqual(r.types, []);
  assert.equal(r.status, "inconclusive");
  assert.ok(r.notes.some((n) => n.code === "ref.unreachable"));
});

test("check: IP timeout without a reference stays medium confidence", async (t) => {
  const r = await withBlackhole(undefined);
  if (r.evidence.ips[0]?.tcp.outcome !== "timeout") return t.skip("network does not black-hole TEST-NET-1");
  assert.deepEqual(r.types, ["ip"]);
  assert.equal(r.confidence, "medium");
});
