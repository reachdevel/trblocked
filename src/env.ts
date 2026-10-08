import { execFile } from "node:child_process";
import type { Note } from "./types.ts";

export interface Route {
  iface?: string;
  gateway?: string;
}

/** `route -n get <dest>` on macOS/BSD. */
export function parseRouteDarwin(text: string): Route {
  return {
    gateway: /^\s*gateway:\s*(\S+)/m.exec(text)?.[1],
    iface: /^\s*interface:\s*(\S+)/m.exec(text)?.[1],
  };
}

/** `ip route get <dest>` or `ip route show default` on Linux (first line wins). */
export function parseRouteLinux(text: string): Route {
  const line = text.split("\n").find((l) => /\bdev\s+\S+/.test(l)) ?? "";
  return { gateway: /\bvia\s+(\S+)/.exec(line)?.[1], iface: /\bdev\s+(\S+)/.exec(line)?.[1] };
}

/** Interfaces that carry traffic for a tunnel. Merely existing proves nothing: macOS keeps several idle utunN around. */
export function isTunnelInterface(name: string): boolean {
  return /^(utun|tun|tap|ppp|wg|ipsec|nordlynx|tailscale|zt|proton)/i.test(name);
}

/** Default gateways phone hotspots hand out (heuristic, not proof). */
const HOTSPOT_GATEWAYS: Record<string, "ios" | "android"> = {
  "172.20.10.1": "ios",
  "192.168.43.1": "android",
  "192.168.49.1": "android",
};

export interface Environment {
  vpn?: { iface: string };
  hotspot?: { gateway: string; kind: "ios" | "android" };
  warnings: Note[];
}

/**
 * `toPublic`: the route the OS would use for a public address (a VPN shows up here, including OpenVPN's
 * two /1 routes that never touch the default route). `toDefault`: the physical default route (hotspot check).
 */
export function evaluateRoutes(toPublic: Route, toDefault: Route): Environment {
  const env: Environment = { warnings: [] };
  if (toPublic.iface && isTunnelInterface(toPublic.iface)) {
    env.vpn = { iface: toPublic.iface };
    env.warnings.push({ code: "env.vpn", params: { iface: toPublic.iface } });
  }
  const kind = toDefault.gateway ? HOTSPOT_GATEWAYS[toDefault.gateway] : undefined;
  if (kind && toDefault.gateway) {
    env.hotspot = { gateway: toDefault.gateway, kind };
    env.warnings.push({ code: "env.hotspot", params: { kind: { code: `env.hotspot.${kind}` } } });
  }
  return env;
}

export type Run = (cmd: string, args: string[]) => Promise<string | undefined>;

export const run: Run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000 }, (err, stdout) => resolve(err ? undefined : stdout));
  });

/** Never throws; on unsupported platforms or failures it simply reports nothing. */
export async function detectEnvironment(publicIp = "1.1.1.1", platform: string = process.platform, exec: Run = run): Promise<Environment> {
  if (platform === "darwin") {
    const [pub, def] = await Promise.all([exec("/sbin/route", ["-n", "get", publicIp]), exec("/sbin/route", ["-n", "get", "default"])]);
    return evaluateRoutes(pub ? parseRouteDarwin(pub) : {}, def ? parseRouteDarwin(def) : {});
  }
  if (platform === "linux") {
    const [pub, def] = await Promise.all([exec("ip", ["route", "get", publicIp]), exec("ip", ["route", "show", "default"])]);
    return evaluateRoutes(pub ? parseRouteLinux(pub) : {}, def ? parseRouteLinux(def) : {});
  }
  return { warnings: [] };
}
