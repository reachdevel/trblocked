import net from "node:net";
import type { Target } from "./types.ts";

export class TargetError extends Error {
  readonly input: string;
  constructor(input: string) {
    super(`Invalid target: ${input}`);
    this.input = input;
  }
}

/** Accepts `example.com`, `example.com/path`, `http://example.com:8080/x?y`, `https://example.com`, `1.2.3.4`. */
export function parseTarget(input: string, defaultPort = 443): Target {
  const trimmed = input.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== "http" && scheme !== "https") throw new TargetError(input);
  let url: URL;
  try {
    url = new URL(scheme ? trimmed : `https://${trimmed}`);
  } catch {
    throw new TargetError(input);
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new TargetError(input);
  const explicitPort = url.port ? Number(url.port) : undefined;
  return {
    host,
    isIp: net.isIP(host) !== 0,
    port: explicitPort ?? defaultPort,
    ...(explicitPort !== undefined ? { explicitPort } : {}),
    ...(scheme ? { scheme: scheme as "http" | "https" } : {}),
    path: url.pathname + url.search,
  };
}
