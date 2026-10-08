import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cached: { key: Buffer; cert: Buffer } | undefined;

/**
 * A throwaway self-signed certificate for the local TLS servers in the tests, generated on first use.
 * (No key material is committed to the repository: secret scanners rightly flag those.)
 */
export function testCert(): { key: Buffer; cert: Buffer } {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "trblocked-cert-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-days", "2", "-subj", "/CN=trblocked.test"], { stdio: "ignore" });
  } catch (err) {
    throw new Error(`The tests need the "openssl" command to create a throwaway TLS certificate: ${err instanceof Error ? err.message : err}`);
  }
  cached = { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) };
  return cached;
}
