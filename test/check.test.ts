import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { check } from "../src/check.ts";
import type { CheckResult, ConfigOverride, DnsAnswer, ReferenceProbe, ReferenceResult } from "../src/types.ts";

const BLOCK_PAGE = `<html><body><span>blocked.test, 01/01/2020 tarihli ve 2020/1 Sayılı Test Mahkemesi kararıyla erişime engellenmiştir.</span></body></html>`;
const answer = (...addresses: string[]): DnsAnswer => ({ source: "fake", rcode: "NOERROR", addresses });
// Loopback is a bogon, so the ISP/system answers are "no answer" here (no DNS verdict); the real IPs come from the reference.
const silent = async (): Promise<DnsAnswer> => ({ source: "fake", rcode: "TIMEOUT", addresses: [] });
const dns = { isp: silent, system: silent, truth: async () => answer("127.0.0.1") };
const hostOf = (req: http.IncomingMessage) => (req.headers.host ?? "").split(":")[0];

interface Lab {
  httpPort: number;
  closedPort: number;
  config: ConfigOverride;
  close(): void;
}

/** A local plain-HTTP server, a control target and a closed port, so everything runs offline. */
async function lab(handler: http.RequestListener, extra: ConfigOverride = {}): Promise<Lab> {
  const server = http.createServer(handler);
  const control = net.createServer((s) => s.destroy());
  const closed = net.createServer();
  await Promise.all([server, control, closed].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
  const port = (s: net.Server) => (s.address() as net.AddressInfo).port;
  const closedPort = port(closed);
  await new Promise((r) => closed.close(r)); // nothing listens there any more: connections are refused
  return {
    httpPort: port(server),
    closedPort,
    close: () => (server.closeAllConnections(), server.close(), control.close()),
    config: {
      neutralHost: "neutral.test",
      controlTarget: { host: "127.0.0.1", port: port(control) },
      ports: { http: port(server), tls: closedPort },
      timeoutsMs: { tcp: 500, tls: 500, dns: 500, http: 500 },
      http: { controlTimeoutMs: 500, decisionAttempts: 1, decisionTimeoutMs: 500 },
      ...extra,
    },
  };
}

const codes = (r: CheckResult) => r.notes.map((n) => n.code);
const fakeReference = (reachable: boolean | undefined, seen: { endpoints?: unknown } = {}): ReferenceProbe => ({
  name: "fake",
  probe: async (req): Promise<ReferenceResult> => ((seen.endpoints = req.endpoints), { provider: "fake", reachable, samples: [], detail: "fake" }),
});

test("Host-based drop (an HTTP-only home server): real Host silent, neutral Host answered -> http block, NOT an ip block", async () => {
  const l = await lab((req, res) => (hostOf(req) === "blocked.test" ? undefined : res.end("ok"))); // hangs for the blocked Host
  try {
    const r = await check("blocked.test", l.config, { dns });
    assert.deepEqual(r.types, ["http"]);
    assert.equal(r.status, "blocked");
    assert.equal(r.confidence, "medium");
    assert.ok(codes(r).includes("http.dropped"));
    assert.ok(!codes(r).includes("tcp.timeout"));
    assert.equal(r.evidence.ips[0]!.httpAlt?.outcome, "ok");
  } finally {
    l.close();
  }
});

test("a reset (not a hang) on the real Host counts as well", async () => {
  const l = await lab((req, res) => (hostOf(req) === "blocked.test" ? req.socket.destroy() : res.end("ok")));
  try {
    const r = await check("blocked.test", l.config, { dns });
    assert.deepEqual(r.types, ["http"]);
    assert.equal(r.evidence.ips[0]!.http?.outcome, "reset");
  } finally {
    l.close();
  }
});

test("URL-level vs host-level: the root path decides", async () => {
  const handler: http.RequestListener = (req, res) => (hostOf(req) === "blocked.test" && req.url?.startsWith("/secret") ? undefined : res.end("ok"));
  const l = await lab(handler);
  try {
    const url = await check("http://blocked.test:" + l.httpPort + "/secret/file.zip", l.config, { dns });
    assert.deepEqual(url.types, ["http"]);
    assert.ok(codes(url).includes("http.urlLevel"), codes(url).join());
    assert.equal(url.notes.find((n) => n.code === "http.urlLevel")?.params?.path, "/secret/file.zip");
    // Not blocked at all when the path is fine.
    const fine = await check("http://blocked.test:" + l.httpPort + "/public", l.config, { dns });
    assert.equal(fine.status, "accessible");
  } finally {
    l.close();
  }
  const whole = await lab((req, res) => (hostOf(req) === "blocked.test" ? undefined : res.end("ok")));
  try {
    const r = await check("http://blocked.test:" + whole.httpPort + "/x", whole.config, { dns });
    assert.ok(codes(r).includes("http.hostLevel"));
  } finally {
    whole.close();
  }
});

test("a /landpage redirect injected for the root request is a block, not proof that the Host 'answers'", async () => {
  // Real Host + full path: hangs. Real Host + "/": the middlebox answers with its redirect. Neutral Host: fine.
  const l = await lab((req, res) => {
    if (hostOf(req) !== "blocked.test") return void res.end("ok");
    if (req.url === "/") return void res.writeHead(307, { location: "http://192.0.2.7/landpage?op=2&ms=x" }).end();
  });
  try {
    const r = await check(`http://blocked.test:${l.httpPort}/deep/file.zip`, l.config, { dns });
    assert.deepEqual(r.types, ["http"]);
    assert.equal(r.confidence, "high");
    assert.ok(codes(r).includes("http.blockPage"));
    assert.ok(!codes(r).includes("http.urlLevel"), "must not claim a URL-level block");
  } finally {
    l.close();
  }
});

test("a server that only speaks HTTP is accessible, not 'IP blocked' because 443 is closed", async () => {
  const l = await lab((_req, res) => res.end("ok"));
  try {
    const noScheme = await check("healthy.test", l.config, { dns }); // 443 refused, 80 answers
    assert.equal(noScheme.status, "accessible");
    assert.deepEqual(noScheme.types, []);
    const httpScheme = await check(`http://healthy.test:${l.httpPort}/`, l.config, { dns });
    assert.equal(httpScheme.status, "accessible");
    assert.equal(httpScheme.evidence.ips[0]!.tlsRealSni, undefined, "no TLS is attempted for http://");
  } finally {
    l.close();
  }
});

test("an injected block page is conclusive and yields the court decision", async () => {
  const l = await lab((req, res) => res.end(hostOf(req) === "blocked.test" ? BLOCK_PAGE : "ok"));
  try {
    const r = await check("blocked.test", l.config, { dns });
    assert.deepEqual(r.types, ["http"]);
    assert.equal(r.confidence, "high");
    assert.match(r.decision ?? "", /Test Mahkemesi kararıyla erişime engellenmiştir/);
  } finally {
    l.close();
  }
});

test("--injection repeats the request and counts hits when the page is injected only some of the time", async () => {
  let n = 0;
  const l = await lab((_req, res) => res.end(++n % 4 === 3 ? BLOCK_PAGE : "<html>real</html>"), {
    http: { controlTimeoutMs: 500, decisionAttempts: 1, decisionTimeoutMs: 500, injection: { enabled: true, attempts: 8, timeoutMs: 500 } },
  });
  try {
    const r = await check("blocked.test", l.config, { dns });
    assert.deepEqual(r.types, ["http"]);
    const note = r.notes.find((x) => x.code === "http.injection");
    assert.ok(note, codes(r).join());
    assert.equal(note!.params?.attempts, 8);
    assert.ok((note!.params?.hits as number) >= 2);
  } finally {
    l.close();
  }
  const clean = await lab((_req, res) => res.end("ok"), { http: { controlTimeoutMs: 500, decisionAttempts: 1, decisionTimeoutMs: 500, injection: { enabled: true, attempts: 4, timeoutMs: 500 } } });
  try {
    const r = await check("clean.test", clean.config, { dns });
    assert.equal(r.status, "accessible");
    assert.ok(codes(r).includes("http.injectionNone"));
  } finally {
    clean.close();
  }
});

test("outside vantage point: agreeing -> high confidence; also dead outside -> the drop is a server quirk, not a block", async () => {
  const hang: http.RequestListener = (req, res) => (hostOf(req) === "blocked.test" ? undefined : res.end("ok"));
  const l = await lab(hang);
  try {
    const seen: { endpoints?: unknown } = {};
    const up = await check("blocked.test", l.config, { dns, reference: fakeReference(true, seen) });
    assert.deepEqual(up.types, ["http"]);
    assert.equal(up.confidence, "high");
    assert.deepEqual(seen.endpoints, [{ protocol: "HTTP", port: l.httpPort }]); // only the protocol the evidence is about

    const down = await check("blocked.test", l.config, { dns, reference: fakeReference(false) });
    assert.deepEqual(down.types, []);
    assert.equal(down.status, "inconclusive");
    assert.ok(codes(down).includes("ref.unreachable"));
  } finally {
    l.close();
  }
});

test("a real IP block (every port silent) still asks the outside about both protocols when no scheme was given", async (t) => {
  const l = await lab((_req, res) => res.end("ok"));
  try {
    const seen: { endpoints?: unknown } = {};
    const r = await check("blocked.test", { ...l.config, ports: { http: 80, tls: 443 } }, {
      dns: { isp: dns.isp, system: dns.system, truth: async () => answer("192.0.2.1") }, // TEST-NET-1: a black hole
      reference: fakeReference(true, seen),
    });
    if (r.evidence.ips[0]?.tcp.outcome !== "timeout") return t.skip("network does not black-hole TEST-NET-1");
    assert.deepEqual(r.types, ["ip"]);
    assert.equal(r.confidence, "high");
    assert.deepEqual(seen.endpoints, [{ protocol: "HTTP", port: 80 }, { protocol: "HTTPS", port: 443 }]);
  } finally {
    l.close();
  }
});

test("a name that exists but has no IPv4 address is reported as such, not as a failed DoH lookup", async () => {
  const l = await lab((_req, res) => res.end("ok"));
  try {
    const noA = async (): Promise<DnsAnswer> => ({ source: "fake", rcode: "NOERROR", addresses: [] });
    const r = await check("ipv6only.test", l.config, { dns: { isp: silent, system: silent, truth: noA } });
    assert.equal(r.status, "inconclusive");
    assert.deepEqual(codes(r), ["dns.noIspAnswer", "dns.noARecord"]);
    assert.equal(r.evidence.ips.length, 0);
  } finally {
    l.close();
  }
});
