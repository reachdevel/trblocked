import assert from "node:assert/strict";
import https from "node:https";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { resolveConfig } from "../src/config.ts";
import { measureThrottling } from "../src/throttle.ts";
import { testCert } from "./helpers/tls-cert.ts";

const { key, cert } = testCert();

const BIG = 3_000_000;
const chunk = Buffer.alloc(10_000, 97);

interface Behaviour {
  /** Bytes/second for connections that present this SNI (undefined = unlimited). */
  slowSni?: string;
  slowBps?: number;
  /** Respond 403 when the SNI is not this one (like a CDN refusing SNI/Host mismatch). */
  strictSni?: string;
  bodyBytes?: number;
}

async function server(b: Behaviour) {
  const srv = https.createServer({ key, cert }, (req, res) => {
    const sni = (req.socket as unknown as { servername?: string }).servername;
    if (b.strictSni && sni !== b.strictSni) {
      res.writeHead(403).end("nope");
      return;
    }
    let remaining = b.bodyBytes ?? BIG;
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const slow = b.slowSni !== undefined && sni === b.slowSni;
    const tick = () => {
      if (res.destroyed) return;
      const n = Math.min(chunk.length, remaining);
      remaining -= n;
      const ok = res.write(chunk.subarray(0, n));
      if (remaining <= 0) return void res.end();
      if (slow) setTimeout(tick, (n / b.slowBps!) * 1000);
      else if (ok) setImmediate(tick);
      else res.once("drain", tick);
    };
    tick();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, port: (srv.address() as AddressInfo).port };
}

const cfgFor = (extra: object = {}) =>
  resolveConfig({
    neutralHost: "neutral.test",
    timeoutsMs: { tls: 3000 },
    throttle: { enabled: true, maxBytes: 800_000, maxWindowMs: 1200, minBytes: 100_000, ratio: 0.2, minControlBytesPerSec: 50_000, externalControls: [], ...extra },
  });

test("detects SNI-based throttling with a same-IP control (high confidence)", async () => {
  const { srv, port } = await server({ slowSni: "slow.test", slowBps: 100_000 });
  try {
    const r = await measureThrottling("127.0.0.1", port, "slow.test", "/big", cfgFor());
    assert.equal(r.throttled, true);
    assert.equal(r.confidence, "high");
    assert.equal(r.evidence.control?.kind, "same-ip-sni");
    assert.ok(r.evidence.ratio! < 0.2, `ratio ${r.evidence.ratio}`);
  } finally {
    srv.close();
  }
});

test("no throttling when both SNIs are equally fast", async () => {
  const { srv, port } = await server({});
  try {
    const r = await measureThrottling("127.0.0.1", port, "fast.test", "/big", cfgFor());
    assert.equal(r.throttled, false);
    assert.ok(r.evidence.ratio! > 0.2, `ratio ${r.evidence.ratio}`);
  } finally {
    srv.close();
  }
});

test("a small page is reported as not judgeable instead of guessing", async () => {
  const { srv, port } = await server({ bodyBytes: 5_000 });
  try {
    const r = await measureThrottling("127.0.0.1", port, "small.test", "/", cfgFor());
    assert.equal(r.throttled, undefined);
    assert.equal(r.evidence.reason?.code, "throttle.reason.small");
  } finally {
    srv.close();
  }
});

test("falls back to an external control (medium confidence) when the server rejects the SNI swap", async () => {
  const target = await server({ strictSni: "slow.test", slowSni: "slow.test", slowBps: 100_000 });
  const control = await server({});
  try {
    const cfg = cfgFor({ externalControls: [`https://127.0.0.1:${control.port}/fast`] });
    const r = await measureThrottling("127.0.0.1", target.port, "slow.test", "/big", cfg);
    assert.equal(r.throttled, true);
    assert.equal(r.confidence, "medium");
    assert.equal(r.evidence.control?.kind, "external");
  } finally {
    target.srv.close();
    control.srv.close();
  }
});

test("no usable control -> not judgeable", async () => {
  const { srv, port } = await server({ strictSni: "slow.test" });
  try {
    const r = await measureThrottling("127.0.0.1", port, "slow.test", "/big", cfgFor());
    assert.equal(r.throttled, undefined);
    assert.equal(r.evidence.reason?.code, "throttle.reason.noControl");
  } finally {
    srv.close();
  }
});

test("follows a same-IP redirect to reach a real payload", async () => {
  const srv = https.createServer({ key, cert }, (req, res) => {
    if (req.url === "/") return void res.writeHead(301, { location: "https://slow.test/big" }).end();
    res.writeHead(200).end(Buffer.alloc(BIG, 98));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const r = await measureThrottling("127.0.0.1", (srv.address() as AddressInfo).port, "slow.test", "/", cfgFor());
    assert.equal(r.evidence.workload.path, "/big");
    assert.equal(r.throttled, false);
  } finally {
    srv.close();
  }
});
