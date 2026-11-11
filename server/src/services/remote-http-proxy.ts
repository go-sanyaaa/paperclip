import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type Socket } from "node:net";

/** Only operator-owned environment is consulted, never connection configuration. */
export function remoteHttpProxy(endpoint: URL, env: NodeJS.ProcessEnv): URL | null {
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = endpoint.port || (endpoint.protocol === "https:" ? "443" : "80");
  const bypass = env.no_proxy ?? env.NO_PROXY ?? "";
  for (const entry of bypass.split(",")) {
    const rule = entry.trim().toLowerCase();
    if (!rule) continue;
    if (rule === "*") return null;
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(rule);
    if (!match || (match[2] && match[2] !== port)) continue;
    const host = match[1]!.replace(/^\[|\]$/g, "");
    if (host.startsWith(".") || host.startsWith("*.")) {
      const suffix = host.replace(/^\*?\./, "");
      if (hostname === suffix || hostname.endsWith(`.${suffix}`)) return null;
    } else if (hostname === host) return null;
  }
  const value = endpoint.protocol === "https:"
    ? env.https_proxy ?? env.HTTPS_PROXY
    : env.http_proxy ?? env.HTTP_PROXY;
  if (!value) return null;
  let proxy: URL;
  try {
    proxy = new URL(value);
  } catch {
    throw new Error("Invalid remote HTTP proxy URL");
  }
  if (!["http:", "https:"].includes(proxy.protocol)) {
    throw new Error("Remote HTTP proxy must use HTTP or HTTPS");
  }
  return proxy;
}

/** CONNECT to the validated IP, not the hostname: proxy DNS cannot rebind it.
 * The operator's proxy is trusted to honour CONNECT. Its peer is deliberately
 * not compared with the destination IP; target TLS is still checked by caller.
 */
export function connectRemoteHttpProxy(input: {
  proxy: URL;
  address: string;
  port: number;
  signal: AbortSignal | null;
  timeoutMs: number;
}): Promise<Socket> {
  const { proxy, address, port, signal, timeoutMs } = input;
  const authority = `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
  const headers: Record<string, string> = { Host: authority };
  if (proxy.username || proxy.password) {
    headers["Proxy-Authorization"] = `Basic ${Buffer.from(
      `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
    ).toString("base64")}`;
  }
  return new Promise((resolve, reject) => {
    const request = (proxy.protocol === "https:" ? httpsRequest : httpRequest)({
      hostname: proxy.hostname.replace(/^\[|\]$/g, ""),
      port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
      method: "CONNECT",
      path: authority,
      headers,
      // Do not recurse through Node's environment-aware global proxy agent.
      agent: false,
      ...(signal ? { signal } : {}),
    });
    const timer = setTimeout(() => request.destroy(new Error("Remote HTTP proxy connect timed out")), timeoutMs);
    timer.unref?.();
    const clear = () => clearTimeout(timer);
    request.once("error", () => {
      clear();
      // Do not include proxy URLs, credentials or provider headers in errors.
      reject(new Error(signal?.aborted ? "Remote HTTP proxy request aborted" : "Remote HTTP proxy connection failed"));
    });
    request.once("connect", (response, socket, head) => {
      clear();
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Remote HTTP proxy CONNECT returned HTTP ${response.statusCode}`));
        return;
      }
      if (head.length) socket.unshift(head);
      if (signal?.aborted) {
        socket.destroy();
        reject(new Error("Remote HTTP proxy request aborted"));
        return;
      }
      resolve(socket);
    });
    request.end();
  });
}
