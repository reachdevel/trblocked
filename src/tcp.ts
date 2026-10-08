import net from "node:net";
import type { TcpResult } from "./types.ts";

const CODE_TO_OUTCOME: Record<string, TcpResult["outcome"]> = {
  ECONNRESET: "reset",
  ECONNREFUSED: "refused",
  ETIMEDOUT: "timeout",
  ENETUNREACH: "unreachable",
  EHOSTUNREACH: "unreachable",
};

export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<TcpResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (r: Omit<TcpResult, "ms">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ...r, ms: Date.now() - start });
    };
    const timer = setTimeout(() => finish({ outcome: "timeout" }), timeoutMs);
    socket.once("connect", () => finish({ outcome: "ok" }));
    socket.once("error", (err: NodeJS.ErrnoException) =>
      finish({ outcome: CODE_TO_OUTCOME[err.code ?? ""] ?? "error", code: err.code }),
    );
  });
}
