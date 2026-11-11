import { createServer, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { guardedRemoteHttpFetch } from "../services/remote-http-fetch.js";
import { remoteHttpProxy } from "../services/remote-http-proxy.js";

const servers: Server[] = [];
const sockets = new Set<Socket>();
const publicAddress = [93, 184, 216, 34].join(".");
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});
async function listen(server: Server) {
  servers.push(server);
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}
const error = (message: string, code: string) => Object.assign(new Error(message), { code });

describe("operator proxy selection", () => {
  it("honours lowercase precedence, protocol selection and NO_PROXY boundaries", () => {
    const env = { HTTPS_PROXY: "http://upper:80", https_proxy: "http://lower:81", HTTP_PROXY: "http://plain:82", NO_PROXY: ".example.com:443,localhost" };
    expect(remoteHttpProxy(new URL("https://api.example.com"), env)).toBeNull();
    expect(remoteHttpProxy(new URL("https://example.com"), env)).toBeNull();
    expect(remoteHttpProxy(new URL("https://notexample.com"), env)?.hostname).toBe("lower");
    expect(remoteHttpProxy(new URL("https://api.example.com:444"), env)?.hostname).toBe("lower");
    expect(remoteHttpProxy(new URL("http://github.test"), env)?.hostname).toBe("plain");
    expect(remoteHttpProxy(new URL("https://github.test"), { ...env, no_proxy: "*" })).toBeNull();
    expect(remoteHttpProxy(new URL("https://github.test"), {})).toBeNull();
    expect(() => remoteHttpProxy(new URL("https://github.test"), { HTTPS_PROXY: "socks5://secret:password@proxy" })).toThrow("HTTP or HTTPS");
  });
});

describe("guarded HTTP over an operator CONNECT proxy", () => {
  it("pins CONNECT to the approved IP, preserves Host, separates credentials and leaves redirects manual", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const upstreamPort = await listen(createServer((req, res) => {
      seen.push({ host: req.headers.host, auth: req.headers.authorization, proxyAuth: req.headers["proxy-authorization"] });
      res.writeHead(302, { location: "http://127.0.0.1/private" });
      res.end("redirect");
    }));
    const proxy = createServer();
    const proxyPort = await listen(proxy);
    proxy.on("connect", (req, client, head) => {
      seen.push({ target: req.url, proxyAuth: req.headers["proxy-authorization"], auth: req.headers.authorization });
      const upstream = connect(upstreamPort, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      sockets.add(upstream);
    });
    let lookups = 0;
    const response = await guardedRemoteHttpFetch("http://github.test/mcp/", {
      headers: { authorization: "Bearer provider-token" },
    }, {
      allowPrivateNetwork: false,
      lookup: async () => { lookups++; return [{ address: publicAddress, family: 4 }]; },
      proxyEnv: { HTTP_PROXY: `http://user:password@127.0.0.1:${proxyPort}` },
      error,
    });
    expect(response.status).toBe(302);
    await response.text();
    expect(lookups).toBe(1);
    expect(seen).toEqual([
      { target: `${publicAddress}:80`, proxyAuth: `Basic ${Buffer.from("user:password").toString("base64")}`, auth: undefined },
      { host: "github.test", auth: "Bearer provider-token", proxyAuth: undefined },
    ]);
  });

  it("rejects private destinations before contacting the proxy", async () => {
    let connections = 0;
    const proxy = createServer();
    proxy.on("connection", () => connections++);
    const port = await listen(proxy);
    await expect(guardedRemoteHttpFetch("https://github.test/mcp/", {}, {
      allowPrivateNetwork: false,
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      proxyEnv: { HTTPS_PROXY: `http://127.0.0.1:${port}` },
      error,
    })).rejects.toThrow();
    expect(connections).toBe(0);
  });

  it("does not fall back to direct egress when the proxy refuses CONNECT", async () => {
    const proxy = createServer();
    proxy.on("connect", (_req, socket) => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"));
    const port = await listen(proxy);
    await expect(guardedRemoteHttpFetch("https://github.test/mcp/", {}, {
      allowPrivateNetwork: false,
      lookup: async () => [{ address: publicAddress, family: 4 }],
      proxyEnv: { HTTPS_PROXY: `http://user:password@127.0.0.1:${port}` },
      error,
    })).rejects.toThrow("CONNECT returned HTTP 407");
  });

  it("bounds a silent proxy handshake and honours cancellation", async () => {
    const proxy = createServer();
    proxy.on("connect", () => { /* Deliberately never acknowledge CONNECT. */ });
    const port = await listen(proxy);
    const options = {
      allowPrivateNetwork: false,
      lookup: async () => [{ address: publicAddress, family: 4 }],
      proxyEnv: { HTTPS_PROXY: `http://127.0.0.1:${port}` },
      connectTimeoutMs: 40,
      error,
    };
    await expect(guardedRemoteHttpFetch("https://github.test/mcp/", {}, options))
      .rejects.toThrow("proxy connection failed");
    const controller = new AbortController();
    const pending = guardedRemoteHttpFetch("https://github.test/mcp/", { signal: controller.signal }, {
      ...options, connectTimeoutMs: 10_000,
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
