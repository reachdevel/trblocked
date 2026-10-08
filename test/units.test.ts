import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { firstDefinitive, isBogon, judgeDns } from "../src/dns.ts";
import { parseTarget } from "../src/target.ts";
import { tcpProbe } from "../src/tcp.ts";
import type { DnsAnswer } from "../src/types.ts";

const cfg = { blockPageIps: ["195.175.254.2"] };
const ans = (rcode: DnsAnswer["rcode"], addresses: string[] = []): DnsAnswer => ({ source: "t", rcode, addresses });
const never = async () => {
  throw new Error("verifyCert must not be called");
};

test("parseTarget handles hosts, urls, schemes, ports and ips", () => {
  assert.deepEqual(parseTarget("Example.com"), { host: "example.com", isIp: false, port: 443, path: "/" });
  assert.deepEqual(parseTarget("https://a.b:8443/x?y=1"), { host: "a.b", isIp: false, port: 8443, explicitPort: 8443, scheme: "https", path: "/x?y=1" });
  assert.deepEqual(parseTarget("http://files.example/mods/download.php?name=a.zip"), {
    host: "files.example", isIp: false, port: 443, scheme: "http", path: "/mods/download.php?name=a.zip",
  });
  assert.equal(parseTarget("http://a.test:8080/").explicitPort, 8080);
  assert.equal(parseTarget("a.test").scheme, undefined); // no scheme: both protocols are tested
  assert.equal(parseTarget("1.2.3.4").isIp, true);
  assert.equal(parseTarget("[::1]").host, "::1");
  assert.throws(() => parseTarget("http://"));
  assert.throws(() => parseTarget("ftp://a.test/"), /Invalid target/);
});

test("isBogon", () => {
  for (const ip of ["0.0.0.0", "10.1.1.1", "127.0.0.1", "192.168.0.1", "172.20.0.1", "100.64.0.1"]) assert.ok(isBogon(ip), ip);
  for (const ip of ["1.1.1.1", "172.32.0.1", "195.175.254.2"]) assert.ok(!isBogon(ip), ip);
});

test("judgeDns: block-page IP", async () => {
  const v = await judgeDns(ans("NOERROR", ["195.175.254.2"]), ans("NOERROR", ["1.2.3.4"]), cfg, never);
  assert.deepEqual(v, { blocked: true, reason: "blockpage-ip" });
});

test("judgeDns: NXDOMAIN while truth exists", async () => {
  const v = await judgeDns(ans("NXDOMAIN"), ans("NOERROR", ["1.2.3.4"]), cfg, never);
  assert.deepEqual(v, { blocked: true, reason: "nxdomain" });
});

test("judgeDns: overlapping answers are fine", async () => {
  const v = await judgeDns(ans("NOERROR", ["1.2.3.4", "5.6.7.8"]), ans("NOERROR", ["1.2.3.4"]), cfg, never);
  assert.equal(v.blocked, false);
});

test("judgeDns: disjoint answers decided by certificate", async () => {
  const a = ans("NOERROR", ["9.9.9.9"]);
  const t = ans("NOERROR", ["1.2.3.4"]);
  assert.deepEqual(await judgeDns(a, t, cfg, async () => true), { blocked: false, reason: "none" });
  assert.deepEqual(await judgeDns(a, t, cfg, async () => false), { blocked: true, reason: "cert-mismatch" });
  // Handshake could not complete (e.g. SNI blocked there too): must not be called a DNS block.
  assert.deepEqual(await judgeDns(a, t, cfg, async () => undefined), { blocked: false, reason: "unknown" });
});

test("judgeDns: resolver failure is unknown, not blocked", async () => {
  assert.deepEqual(await judgeDns(ans("TIMEOUT"), ans("NOERROR", ["1.2.3.4"]), cfg, never), { blocked: false, reason: "unknown" });
});

test("firstDefinitive returns the first definitive answer, skipping failures", async () => {
  const slow = new Promise<DnsAnswer>((r) => setTimeout(() => r(ans("NOERROR", ["1.1.1.1"])), 30));
  const failing = Promise.resolve(ans("TIMEOUT"));
  assert.deepEqual((await firstDefinitive([failing, slow], "x")).addresses, ["1.1.1.1"]);
  assert.equal((await firstDefinitive([failing], "x")).rcode, "TIMEOUT");
});

test("tcpProbe: ok against a local server, refused on a closed port", async () => {
  const server = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  assert.equal((await tcpProbe("127.0.0.1", port, 1000)).outcome, "ok");
  await new Promise((r) => server.close(r));
  assert.equal((await tcpProbe("127.0.0.1", port, 1000)).outcome, "refused");
});
