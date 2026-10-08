import assert from "node:assert/strict";
import https from "node:https";
import net from "node:net";
import test from "node:test";
import { checkMany, type BatchEvent } from "../src/batch.ts";
import { mapPool, Semaphore } from "../src/pool.ts";
import { testCert } from "./helpers/tls-cert.ts";

const { key, cert } = testCert();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("mapPool never exceeds the concurrency limit and keeps input order", async () => {
  let active = 0;
  let peak = 0;
  const out = await mapPool([30, 5, 20, 1, 10, 2, 8], 3, async (ms, i) => {
    active++;
    peak = Math.max(peak, active);
    await sleep(ms);
    active--;
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(peak, 3);
});

test("mapPool handles empty input and concurrency larger than the input", async () => {
  assert.deepEqual(await mapPool([], 4, async () => 1), []);
  assert.deepEqual(await mapPool([1, 2], 50, async (x) => x * 2), [2, 4]);
});

test("Semaphore(1) serializes and releases on error", async () => {
  const sem = new Semaphore(1);
  const log: string[] = [];
  const job = (name: string, ms: number, fail = false) =>
    sem.run(async () => {
      log.push(`${name}:in`);
      await sleep(ms);
      log.push(`${name}:out`);
      if (fail) throw new Error("boom");
    });
  await Promise.allSettled([job("a", 20, true), job("b", 5), job("c", 1)]);
  assert.deepEqual(log, ["a:in", "a:out", "b:in", "b:out", "c:in", "c:out"]);
});

// Fully offline batch: IP targets (no DNS) against local TLS servers; a local server is the control target.
async function localServers() {
  const control = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => control.listen(0, "127.0.0.1", r));
  const web = https.createServer({ key, cert }, (_q, res) => res.end("ok"));
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
  return {
    controlPort: (control.address() as net.AddressInfo).port,
    webPort: (web.address() as net.AddressInfo).port,
    close: () => {
      control.close();
      web.close();
    },
  };
}

test("checkMany: parallel, ordered, isolated failures, progress events", async () => {
  const s = await localServers();
  try {
    const events: BatchEvent[] = [];
    const targets = [`https://127.0.0.1:${s.webPort}`, "http://", `https://127.0.0.1:${s.webPort}/x`];
    const results = await checkMany(targets, {
      concurrency: 3,
      config: { controlTarget: { host: "127.0.0.1", port: s.controlPort }, timeoutsMs: { tcp: 500, tls: 500, dns: 500, http: 500 } },
      onEvent: (e) => events.push(e),
    });

    assert.deepEqual(results.map((r) => r.status), ["accessible", "inconclusive", "accessible"]);
    assert.match(results[1]!.error ?? "", /Invalid target/); // bad input does not sink the batch

    // every target announces start and done; valid ones also plan + connect stage start/end
    for (const i of [0, 2]) {
      const mine = events.filter((e) => e.index === i).map((e) => (e.type === "stage" ? `${e.stage}:${e.state}` : e.type));
      assert.deepEqual(mine, ["start", "plan", "connect:start", "connect:end", "done"]);
    }
    assert.deepEqual(events.filter((e) => e.index === 1).map((e) => e.type), ["start", "done"]);
    const plan = events.find((e) => e.type === "plan" && e.index === 0);
    assert.deepEqual(plan?.type === "plan" ? plan.stages : null, ["connect"]); // IP target: no dns stage
  } finally {
    s.close();
  }
});

test("checkMany runs targets concurrently, not one after another", async () => {
  const s = await localServers();
  try {
    const started: number[] = [];
    const t0 = Date.now();
    await checkMany(Array.from({ length: 6 }, () => `https://127.0.0.1:${s.webPort}`), {
      concurrency: 6,
      config: { controlTarget: { host: "127.0.0.1", port: s.controlPort } },
      onEvent: (e) => e.type === "start" && started.push(Date.now() - t0),
    });
    assert.equal(started.length, 6);
    assert.ok(Math.max(...started) < 100, `all 6 started within 100ms, got ${started}`);
  } finally {
    s.close();
  }
});
