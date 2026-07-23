import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, test } from "vitest";

import {
  createDefaultDiskTransferNetworkDependencies,
  type DirectTransferResponse,
} from "../src/tools/disk-transfer.js";

type CapturedRequest = Readonly<{
  method: string;
  url: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Buffer;
}>;

type LocalTransferServer = Readonly<{
  port: number;
  requests: CapturedRequest[];
  sockets: Set<Socket>;
  close(): Promise<void>;
}>;

async function readRequestBody(
  request: AsyncIterable<Uint8Array>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function startTransferServer(
  respond: (
    request: CapturedRequest,
    response: ServerResponse,
  ) => void | Promise<void>,
): Promise<LocalTransferServer> {
  const requests: CapturedRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const captured = Object.freeze({
          method: request.method ?? "",
          url: request.url ?? "",
          headers: Object.freeze({ ...request.headers }),
          body: await readRequestBody(request),
        });
        requests.push(captured);
        await respond(captured, response);
      } catch {
        if (!response.headersSent) {
          response.writeHead(500);
        }
        response.end();
      }
    })();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    requests,
    sockets,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function collectBody(
  body: AsyncIterable<Uint8Array>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function closeTransferResponse(
  response: DirectTransferResponse,
): Promise<void> {
  await response.cancel();
  await response.close();
}

async function expectSocketsClosed(
  server: LocalTransferServer,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (server.sockets.size > 0 && Date.now() < deadline) {
    await delay(10);
  }
  expect(server.sockets.size).toBe(0);
}

function publicUrl(port: number, path: string): string {
  return `http://disk.yandex.net:${port}${path}`;
}

function pinnedLoopbackContext(
  maxResponseBytes: number,
  observedHostnames: string[],
) {
  return {
    async lookup(hostname: string) {
      observedHostnames.push(hostname);
      return [{ address: "127.0.0.1", family: 4 as const }];
    },
    maxResponseBytes,
    timeoutMs: 2_000,
  };
}

describe.sequential("default Undici disk adapter acceptance", () => {
  test("pins DNS while preserving the public Host and exact binary PUT/GET bytes", async () => {
    const downloaded = Buffer.from([
      0x00, 0xff, 0x80, 0xc3, 0x28, 0x7f, 0x01, 0xfe,
    ]);
    const uploaded = Buffer.from([
      0xff, 0x00, 0x81, 0xf5, 0x28, 0x8c, 0x28, 0x42,
    ]);
    const server = await startTransferServer((request, response) => {
      if (request.method === "PUT") {
        response.writeHead(201, {
          "content-length": "0",
        });
        response.end();
        return;
      }
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(downloaded.byteLength),
      });
      response.end(downloaded);
    });
    try {
      const { transferTransport } =
        createDefaultDiskTransferNetworkDependencies();
      const observedHostnames: string[] = [];
      const uploadResponse = await transferTransport.request(
        {
          url: publicUrl(server.port, "/upload?token=opaque"),
          method: "PUT",
          headers: {
            "content-length": String(uploaded.byteLength),
            "content-type": "application/octet-stream",
          },
          body: (async function* () {
            yield uploaded.subarray(0, 3);
            yield uploaded.subarray(3);
          })(),
          signal: new AbortController().signal,
        },
        pinnedLoopbackContext(1_024, observedHostnames),
      );
      expect(uploadResponse.status).toBe(201);
      expect(await collectBody(uploadResponse.body)).toEqual(
        Buffer.alloc(0),
      );
      await closeTransferResponse(uploadResponse);
      await expectSocketsClosed(server);

      const downloadResponse = await transferTransport.request(
        {
          url: publicUrl(server.port, "/download?token=opaque"),
          method: "GET",
          headers: {},
          signal: new AbortController().signal,
        },
        pinnedLoopbackContext(1_024, observedHostnames),
      );
      expect(downloadResponse.status).toBe(200);
      expect(await collectBody(downloadResponse.body)).toEqual(downloaded);
      await closeTransferResponse(downloadResponse);
      await expectSocketsClosed(server);

      expect(observedHostnames).toEqual([
        "disk.yandex.net",
        "disk.yandex.net",
      ]);
      expect(server.requests).toHaveLength(2);
      expect(server.requests[0]).toMatchObject({
        method: "PUT",
        url: "/upload?token=opaque",
        body: uploaded,
      });
      expect(server.requests[1]).toMatchObject({
        method: "GET",
        url: "/download?token=opaque",
        body: Buffer.alloc(0),
      });
      for (const request of server.requests) {
        expect(request.headers.host).toBe(
          `disk.yandex.net:${server.port}`,
        );
        expect(request.headers.authorization).toBeUndefined();
        expect(request.headers["proxy-authorization"]).toBeUndefined();
        expect(request.headers.cookie).toBeUndefined();
        expect(request.headers["x-api-key"]).toBeUndefined();
      }
      expect(server.requests[0]!.body).toEqual(uploaded);
    } finally {
      await server.close();
    }
  });

  test("enforces the adapter response cap and releases the client socket", async () => {
    const oversized = Buffer.alloc(64, 0xa5);
    const server = await startTransferServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(oversized.byteLength),
      });
      response.end(oversized);
    });
    try {
      const { transferTransport } =
        createDefaultDiskTransferNetworkDependencies();
      const observedHostnames: string[] = [];
      let response: DirectTransferResponse | undefined;
      let observedError: unknown;
      try {
        response = await transferTransport.request(
          {
            url: publicUrl(server.port, "/oversized"),
            method: "GET",
            headers: {},
            signal: new AbortController().signal,
          },
          pinnedLoopbackContext(8, observedHostnames),
        );
        await collectBody(response.body);
      } catch (error) {
        observedError = error;
      } finally {
        if (response !== undefined) {
          await closeTransferResponse(response);
        }
      }

      expect(observedError).toMatchObject({
        name: "ResponseExceededMaxSizeError",
        code: "UND_ERR_RES_EXCEEDED_MAX_SIZE",
      });
      expect(observedHostnames).toEqual(["disk.yandex.net"]);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]!.headers.host).toBe(
        `disk.yandex.net:${server.port}`,
      );
      await expectSocketsClosed(server);
    } finally {
      await server.close();
    }
  });
});
