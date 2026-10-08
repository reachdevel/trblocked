import tls from "node:tls";
import type { TlsResult } from "./types.ts";

/**
 * Handshake against `ip` presenting `servername` as SNI (undefined = no SNI).
 * Certificate errors are not failures here: we only care whether the handshake
 * completes; `authorized` tells whether the cert matched `servername`.
 */
export function tlsProbe(
  ip: string,
  port: number,
  servername: string | undefined,
  timeoutMs: number,
): Promise<TlsResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = tls.connect({ host: ip, port, servername, rejectUnauthorized: false });
    let done = false;
    const finish = (r: Omit<TlsResult, "ms">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ...r, ms: Date.now() - start });
    };
    const timer = setTimeout(() => finish({ outcome: "timeout" }), timeoutMs);
    socket.once("secureConnect", () => finish({ outcome: "ok", authorized: socket.authorized }));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      const code = err.code ?? "";
      // The peer answered with a TLS alert (e.g. unrecognized_name): it is alive and speaking TLS.
      if (code.startsWith("ERR_SSL_") && /ALERT|UNRECOGNIZED/i.test(code)) {
        return finish({ outcome: "alert", code });
      }
      if (code === "ECONNRESET") return finish({ outcome: "reset", code });
      if (code === "ETIMEDOUT") return finish({ outcome: "timeout", code });
      finish({ outcome: "error", code });
    });
  });
}
