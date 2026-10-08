import assert from "node:assert/strict";
import test from "node:test";
import { analyzeHttp, analyzeTcp } from "../src/verdict.ts";
import type { HttpResult, IpEvidence, TcpResult } from "../src/types.ts";

const tcp = (outcome: TcpResult["outcome"]): TcpResult => ({ outcome, ms: 1 });
const ev = (primary: TcpResult["outcome"], http?: TcpResult["outcome"], extra: Partial<IpEvidence> = {}): IpEvidence => ({
  ip: "1.1.1.1", tcp: tcp(primary), ...(http ? { tcpHttp: tcp(http) } : {}), ...extra,
});
const h = (outcome: HttpResult["outcome"], extra: Partial<HttpResult> = {}): HttpResult => ({ outcome, ms: 1, ...extra });

test("443 silent but 80 open (an HTTP-only server) is NOT an IP block", () => {
  const a = analyzeTcp([ev("timeout", "ok")]);
  assert.equal(a.ipBlock, false);
  assert.equal(a.primaryClosed, true);
});

test("every port silent on every IP is an IP block; all resets are the stronger signal", () => {
  assert.deepEqual(analyzeTcp([ev("timeout", "timeout"), ev("timeout", "reset")]), { ipBlock: true, allReset: false, deadCount: 2, primaryClosed: false });
  assert.equal(analyzeTcp([ev("reset", "reset")]).allReset, true);
  assert.equal(analyzeTcp([ev("timeout")]).ipBlock, true); // http:// targets probe a single port
});

test("closed ports (refused) are not blocking; a live IP among dead ones makes it partial", () => {
  assert.equal(analyzeTcp([ev("refused", "refused")]).ipBlock, false);
  const partial = analyzeTcp([ev("timeout", "timeout"), ev("ok", "ok")]);
  assert.equal(partial.ipBlock, false);
  assert.equal(partial.deadCount, 1);
  assert.equal(analyzeTcp([]).ipBlock, false);
});

test("analyzeHttp: a block page injected into the escalation request for \"/\" counts as injected", () => {
  const viaRoot = ev("ok", "ok", { http: h("timeout"), httpAlt: h("ok"), httpRoot: h("ok", { status: 307, blockPage: { signature: "landpage-redirect" } }) });
  assert.equal(analyzeHttp([viaRoot]).injectedHit, viaRoot);
  assert.equal(analyzeHttp([viaRoot]).dropHit, undefined);
});

test("analyzeHttp: injected page wins; a drop needs the neutral Host to answer", () => {
  const injected = ev("ok", "ok", { http: h("ok", { blockPage: { signature: "x" } }) });
  const dropped = ev("ok", "ok", { http: h("timeout"), httpAlt: h("ok", { status: 404 }) });
  const dead = ev("ok", "ok", { http: h("timeout"), httpAlt: h("timeout") });
  const clean = ev("ok", "ok", { http: h("ok", { status: 200 }) });
  assert.equal(analyzeHttp([clean, injected, dropped]).injectedHit, injected);
  assert.equal(analyzeHttp([clean, dropped]).dropHit, dropped);
  assert.equal(analyzeHttp([dead]).dropHit, undefined); // server just not answering HTTP: no verdict
  assert.equal(analyzeHttp([clean]).dropHit, undefined);
  assert.equal(analyzeHttp([ev("ok", "ok", { http: h("reset"), httpAlt: h("ok") })]).dropHit !== undefined, true); // resets count too
});
