import assert from "node:assert/strict";
import test from "node:test";
import { detectEnvironment, evaluateRoutes, isTunnelInterface, parseRouteDarwin, parseRouteLinux } from "../src/env.ts";
import { lookupHostsEntry } from "../src/hosts.ts";

// Captured from a real macOS machine (no VPN).
const DARWIN_PLAIN = `   route to: 1.1.1.1
destination: 1.1.1.1
    gateway: 192.168.0.1
  interface: en0
      flags: <UP,GATEWAY,HOST,DONE,WASCLONED,IFSCOPE,IFREF>`;
const DARWIN_VPN = DARWIN_PLAIN.replace("192.168.0.1", "10.8.0.5").replace("en0", "utun4");
const DARWIN_DEFAULT_IPHONE = `   route to: default\ndestination: default\n    gateway: 172.20.10.1\n  interface: en0`;
const LINUX_PLAIN = "1.1.1.1 via 192.168.1.1 dev wlp2s0 src 192.168.1.50 uid 1000 \n    cache";
const LINUX_VPN = "1.1.1.1 via 10.8.0.1 dev tun0 src 10.8.0.2 uid 1000 \n    cache";
const LINUX_DEFAULT = "default via 192.168.43.1 dev wlan0 proto dhcp metric 600";

test("route parsers", () => {
  assert.deepEqual(parseRouteDarwin(DARWIN_PLAIN), { gateway: "192.168.0.1", iface: "en0" });
  assert.deepEqual(parseRouteLinux(LINUX_PLAIN), { gateway: "192.168.1.1", iface: "wlp2s0" });
  assert.deepEqual(parseRouteLinux("1.1.1.1 dev eth0 src 10.0.0.2"), { gateway: undefined, iface: "eth0" });
  assert.deepEqual(parseRouteDarwin("route: writing to routing socket: not in table"), { gateway: undefined, iface: undefined });
});

test("only an egress tunnel interface counts as VPN; idle utun interfaces do not", () => {
  for (const n of ["utun4", "tun0", "tap0", "ppp0", "wg0", "ipsec0", "tailscale0"]) assert.ok(isTunnelInterface(n), n);
  for (const n of ["en0", "eth0", "wlp2s0", "wlan0", "bridge0", "awdl0"]) assert.ok(!isTunnelInterface(n), n);
  assert.deepEqual(evaluateRoutes(parseRouteDarwin(DARWIN_PLAIN), { gateway: "192.168.0.1", iface: "en0" }).warnings, []);
});

test("VPN is detected from the route to a public IP (covers OpenVPN's /1 routes)", () => {
  const env = evaluateRoutes(parseRouteDarwin(DARWIN_VPN), { gateway: "192.168.0.1", iface: "en0" });
  assert.deepEqual(env.vpn, { iface: "utun4" });
  assert.deepEqual(env.warnings, [{ code: "env.vpn", params: { iface: "utun4" } }]);
});

test("hotspot is detected from the physical default gateway, also under a VPN", () => {
  const env = evaluateRoutes(parseRouteDarwin(DARWIN_VPN), parseRouteDarwin(DARWIN_DEFAULT_IPHONE));
  assert.equal(env.hotspot?.kind, "ios");
  assert.deepEqual(env.warnings.map((w) => w.code), ["env.vpn", "env.hotspot"]);
  assert.equal(evaluateRoutes({}, parseRouteLinux(LINUX_DEFAULT)).hotspot?.kind, "android");
});

test("detectEnvironment runs the right commands per platform and never throws", async () => {
  const calls: string[] = [];
  const fake = (out: Record<string, string>) => async (cmd: string, args: string[]) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    return out[args.join(" ")];
  };
  const mac = await detectEnvironment("1.1.1.1", "darwin", fake({ "-n get 1.1.1.1": DARWIN_VPN, "-n get default": DARWIN_DEFAULT_IPHONE }));
  assert.deepEqual(mac.warnings.map((w) => w.code), ["env.vpn", "env.hotspot"]);
  assert.deepEqual(calls, ["/sbin/route -n get 1.1.1.1", "/sbin/route -n get default"]);

  const linux = await detectEnvironment("1.1.1.1", "linux", fake({ "route get 1.1.1.1": LINUX_VPN, "route show default": LINUX_DEFAULT }));
  assert.deepEqual(linux.warnings.map((w) => w.code), ["env.vpn", "env.hotspot"]);

  assert.deepEqual((await detectEnvironment("1.1.1.1", "darwin", async () => undefined)).warnings, []); // command failed
  assert.deepEqual((await detectEnvironment("1.1.1.1", "win32")).warnings, []); // unsupported platform
});

test("lookupHostsEntry finds the first IPv4 mapping, ignores comments and other hosts", () => {
  const hosts = "127.0.0.1\tlocalhost\n# 1.2.3.4 pastebin.com\n::1 pastebin.com\n195.175.254.2\tPastebin.com www.pastebin.com # blocked\n";
  assert.equal(lookupHostsEntry("pastebin.com", hosts), "195.175.254.2");
  assert.equal(lookupHostsEntry("www.pastebin.com", hosts), "195.175.254.2");
  assert.equal(lookupHostsEntry("example.com", hosts), undefined);
});
