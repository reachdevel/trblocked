import { readFileSync } from "node:fs";

/** First IPv4 that a hosts-file text maps `host` to, or undefined. */
export function lookupHostsEntry(host: string, text: string): string | undefined {
  const want = host.toLowerCase();
  for (const raw of text.split(/\r?\n/)) {
    const [ip, ...names] = raw.replace(/#.*$/, "").trim().split(/\s+/);
    if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && names.some((n) => n.toLowerCase() === want)) return ip;
  }
  return undefined;
}

export function lookupHostsFile(host: string, path = "/etc/hosts"): string | undefined {
  try {
    return lookupHostsEntry(host, readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
