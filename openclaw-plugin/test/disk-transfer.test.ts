import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { parseRuntimeConfig, type RuntimeConfig } from "../src/config.js";
import {
  createDiskTransferExecutor,
  type DirectTransferResponse,
  type DiskTransferDependencies,
} from "../src/tools/disk-transfer.js";

const PROOF_SENTINEL = "approval-proof-secret-sentinel";
const CLOUDRU_SENTINEL = "cloudru-api-key-secret-sentinel";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function temporaryRoots() {
  const base = await realpath(
    await mkdtemp(path.join(process.cwd(), ".nango-disk-transfer-")),
  );
  temporaryDirectories.push(base);
  const uploadRoot = path.join(base, "uploads");
  const downloadRoot = path.join(base, "downloads");
  await mkdir(uploadRoot);
  await mkdir(downloadRoot);
  return { base, uploadRoot, downloadRoot };
}

function runtimeConfig(
  uploadRoot: string,
  downloadRoot: string,
  overrides: Partial<NonNullable<RuntimeConfig["disk"]>> = {},
): RuntimeConfig {
  const parsed = parseRuntimeConfig({
    cloudru: {
      proxyBaseUrl: "https://proxy.example.test",
      projectId: "project",
      evoClawId: "evo",
      apiKey: CLOUDRU_SENTINEL,
    },
    disk: {
      uploadRoots: [uploadRoot],
      downloadRoots: [downloadRoot],
      maxTransferBytes: 1_048_576,
      maxRedirects: 2,
      timeoutMs: 10_000,
      transferHostSuffixes: [
        "disk.yandex.net",
        "disk.yandex.ru",
        "storage.yandex.net",
        "dst.yandex.net",
        "dst.yandex.ru",
      ],
    },
  });
  if (parsed.disk === undefined) {
    throw new Error("test disk config missing");
  }
  return {
    ...parsed,
    disk: {
      ...parsed.disk,
      ...overrides,
    },
  };
}

function emptyDirectResponse(
  status = 201,
  headers: HeadersInit = {},
): DirectTransferResponse {
  return {
    status,
    headers: new Headers(headers),
    body: (async function* () {
      // Intentionally empty.
    })(),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function streamedDirectResponse(
  chunks: readonly Uint8Array[],
  status = 200,
  headers: HeadersInit = {},
): DirectTransferResponse {
  return {
    status,
    headers: new Headers(headers),
    body: (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    })(),
    cancel: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function dependencies(
  overrides: Partial<DiskTransferDependencies> = {},
) {
  const approvalVerifier = {
    verifyAndConsume: vi.fn(() => ({
      ok: true as const,
      operationKind: "mutation" as const,
    })),
  };
  const proxyClient = {
    request: vi.fn(async () => ({
      ok: true as const,
      request: {
        providerConfigKey: "yandex-disk" as const,
        method: "GET" as const,
        path: "v1/disk/resources/upload",
      },
      response: {
        status: 200,
        contentType: "application/json",
        headers: {},
        body: {
          href: "https://uploader.disk.yandex.net/upload-token",
          method: "PUT",
          templated: false,
        },
      },
      outcome: "confirmed" as const,
    })),
  };
  const transferTransport = {
    request: vi.fn(async () => emptyDirectResponse()),
  };
  const dnsLookup = vi.fn(async () => [
    { address: "77.88.8.8", family: 4 as const },
  ]);
  return {
    value: {
      approvalVerifier,
      proxyClient,
      transferTransport,
      dnsLookup,
      ...overrides,
    } satisfies DiskTransferDependencies,
    approvalVerifier,
    proxyClient,
    transferTransport,
    dnsLookup,
  };
}

function uploadParams(localPath: string) {
  return {
    providerConfigKey: "yandex-disk",
    direction: "upload",
    localPath,
    remotePath: "disk:/folder/file.bin",
    overwrite: false,
    __nangoApprovalProof: PROOF_SENTINEL,
  };
}

function downloadParams(localPath: string) {
  return {
    providerConfigKey: "yandex-disk",
    direction: "download",
    localPath,
    remotePath: "disk:/folder/file.bin",
    overwrite: false,
    __nangoApprovalProof: PROOF_SENTINEL,
  };
}

function mockTransferLink(
  deps: ReturnType<typeof dependencies>,
  href: string,
  method: "GET" | "PUT",
) {
  deps.proxyClient.request.mockResolvedValue({
    ok: true,
    request: {
      providerConfigKey: "yandex-disk",
      method: "GET",
      path:
        method === "PUT"
          ? "v1/disk/resources/upload"
          : "v1/disk/resources/download",
    },
    response: {
      status: 200,
      contentType: "application/json",
      headers: {},
      body: { href, method, templated: false },
    },
    outcome: "confirmed",
  });
}

describe("approval and local path boundary", () => {
  test("consumes an exact one-time approval before any filesystem or network I/O", async () => {
    const roots = await temporaryRoots();
    const deps = dependencies();
    deps.approvalVerifier.verifyAndConsume.mockReturnValue({
      ok: false,
      code: "approval_required",
    });
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );
    const params = uploadParams(
      path.join(roots.uploadRoot, "does-not-exist.bin"),
    );

    const result = await executor.execute("tool-call-1", params);

    expect(result).toMatchObject({
      ok: false,
      error: {
        layer: "approval",
        code: "approval_required",
        retryable: false,
      },
      outcome: "not_started",
    });
    expect(deps.approvalVerifier.verifyAndConsume).toHaveBeenCalledWith(
      "nango_disk_transfer",
      "tool-call-1",
      params,
    );
    expect(deps.proxyClient.request).not.toHaveBeenCalled();
    expect(deps.transferTransport.request).not.toHaveBeenCalled();
    expect(deps.dnsLookup).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(PROOF_SENTINEL);
    expect(JSON.stringify(result)).not.toContain(CLOUDRU_SENTINEL);
    expect(JSON.stringify(result)).not.toContain(roots.base);
  });

  test.each([
    { providerConfigKey: undefined },
    { providerConfigKey: "yandex-id" },
    { direction: "sideways" },
    { overwrite: "yes" },
    { remotePath: "" },
    { unexpectedControl: true },
  ])("rejects malformed strict parameters before approval: %o", async (patch) => {
    const roots = await temporaryRoots();
    const deps = dependencies();
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );
    const params = { ...uploadParams("source.bin"), ...patch };

    const result = await executor.execute("tool-call-2", params);

    expect(result).toMatchObject({
      ok: false,
      error: { layer: "validation", code: "invalid_disk_transfer" },
      outcome: "not_started",
    });
    expect(deps.approvalVerifier.verifyAndConsume).not.toHaveBeenCalled();
    expect(deps.proxyClient.request).not.toHaveBeenCalled();
    expect(deps.transferTransport.request).not.toHaveBeenCalled();
  });

  test("rejects traversal and ambiguous relative roots without touching I/O", async () => {
    const roots = await temporaryRoots();
    const secondUploadRoot = path.join(roots.base, "uploads-two");
    await mkdir(secondUploadRoot);
    const deps = dependencies();
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot, {
        uploadRoots: [roots.uploadRoot, secondUploadRoot],
      }),
      deps.value,
    );

    const traversal = await executor.execute(
      "tool-call-3",
      uploadParams("../outside.bin"),
    );
    const ambiguous = await executor.execute(
      "tool-call-4",
      uploadParams("source.bin"),
    );

    expect(traversal).toMatchObject({
      ok: false,
      error: { code: "invalid_local_path" },
      outcome: "not_started",
    });
    expect(ambiguous).toMatchObject({
      ok: false,
      error: { code: "ambiguous_local_path" },
      outcome: "not_started",
    });
    expect(deps.approvalVerifier.verifyAndConsume).not.toHaveBeenCalled();
    expect(deps.proxyClient.request).not.toHaveBeenCalled();
    expect(deps.transferTransport.request).not.toHaveBeenCalled();
  });

  test("rejects the configured root itself and a symlink upload source", async () => {
    const roots = await temporaryRoots();
    const outside = path.join(roots.base, "outside.bin");
    const sourceLink = path.join(roots.uploadRoot, "source-link.bin");
    await writeFile(outside, "outside");
    await symlink(outside, sourceLink);
    const deps = dependencies();
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const rootResult = await executor.execute(
      "tool-call-5",
      uploadParams(roots.uploadRoot),
    );
    const symlinkResult = await executor.execute(
      "tool-call-6",
      uploadParams(sourceLink),
    );

    expect(rootResult).toMatchObject({
      ok: false,
      error: { code: "invalid_local_path" },
      outcome: "not_started",
    });
    expect(symlinkResult).toMatchObject({
      ok: false,
      error: { layer: "local_io", code: "unsafe_local_path" },
      outcome: "not_started",
    });
    expect(deps.approvalVerifier.verifyAndConsume).toHaveBeenCalledTimes(1);
    expect(deps.proxyClient.request).not.toHaveBeenCalled();
    expect(deps.transferTransport.request).not.toHaveBeenCalled();
    expect((await lstat(sourceLink)).isSymbolicLink()).toBe(true);
  });

  test("rejects a symlink destination and does not overwrite it", async () => {
    const roots = await temporaryRoots();
    const outside = path.join(roots.base, "outside-download.bin");
    const destinationLink = path.join(
      roots.downloadRoot,
      "destination-link.bin",
    );
    await writeFile(outside, "outside");
    await symlink(outside, destinationLink);
    const deps = dependencies();
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-7",
      downloadParams(destinationLink),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { layer: "local_io", code: "unsafe_local_path" },
      outcome: "not_started",
    });
    expect(deps.proxyClient.request).not.toHaveBeenCalled();
    expect(deps.transferTransport.request).not.toHaveBeenCalled();
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  test("uses no-follow source opens for regular uploads", async () => {
    const roots = await temporaryRoots();
    const source = path.join(roots.uploadRoot, "source.bin");
    await writeFile(source, "payload");
    const open = vi.fn(async () => {
      throw Object.assign(new Error("stop after flags"), {
        code: "EACCES",
      });
    });
    const deps = dependencies({
      fileSystem: {
        lstat,
        realpath: vi.fn(realpath),
        open,
        rename: vi.fn(),
        link: vi.fn(),
        unlink: vi.fn(),
      },
    });
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    await executor.execute("tool-call-8", uploadParams(source));

    expect(open).toHaveBeenCalledWith(
      source,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
  });

  test("rejects a transfer root writable by another OS identity", async () => {
    const roots = await temporaryRoots();
    const source = path.join(roots.uploadRoot, "shared-source.bin");
    await writeFile(source, "must-not-leave-this-root");
    await chmod(roots.uploadRoot, 0o777);
    const deps = dependencies();
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-shared-root",
      uploadParams(source),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { layer: "local_io", code: "unsafe_local_path" },
      outcome: "not_started",
    });
    expect(deps.proxyClient.request).not.toHaveBeenCalled();
    expect(deps.transferTransport.request).not.toHaveBeenCalled();
  });

  test("rejects a configured root reached through an intermediate symlink", async () => {
    const roots = await temporaryRoots();
    const secureParent = path.join(roots.base, "secure-parent");
    const secureRoot = path.join(secureParent, "allowed");
    const sharedParent = path.join(roots.base, "shared-parent");
    const bridge = path.join(sharedParent, "bridge");
    await mkdir(secureParent);
    await mkdir(secureRoot);
    await mkdir(sharedParent);
    await chmod(sharedParent, 0o777);
    await symlink(secureParent, bridge);
    const aliasedRoot = path.join(bridge, "allowed");
    const aliasedSource = path.join(aliasedRoot, "source.bin");
    await writeFile(path.join(secureRoot, "source.bin"), "payload");
    const deps = dependencies();
    const executor = createDiskTransferExecutor(
      runtimeConfig(aliasedRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-aliased-root",
      uploadParams(aliasedSource),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { layer: "local_io", code: "unsafe_local_path" },
      outcome: "not_started",
    });
    expect(deps.proxyClient.request).not.toHaveBeenCalled();
    expect(deps.transferTransport.request).not.toHaveBeenCalled();
  });
});

describe("upload streaming", () => {
  test("acquires the exact upload link and sends a credential-free streaming PUT", async () => {
    const roots = await temporaryRoots();
    const source = path.join(roots.uploadRoot, "source.bin");
    const payload = new TextEncoder().encode("streamed-upload-payload");
    await writeFile(source, payload);
    const deps = dependencies();
    const directBodies: Uint8Array[] = [];
    deps.transferTransport.request.mockImplementation(
      async (request, context) => {
        expect(request.url).toBe(
          "https://uploader.disk.yandex.net/upload-token",
        );
        expect(request.method).toBe("PUT");
        expect(request.headers).toEqual({
          "content-length": String(payload.byteLength),
          "content-type": "application/octet-stream",
        });
        expect(request.signal).toBeInstanceOf(AbortSignal);
        expect(JSON.stringify(request)).not.toContain(PROOF_SENTINEL);
        expect(JSON.stringify(request)).not.toContain(CLOUDRU_SENTINEL);
        expect(JSON.stringify(request)).not.toContain(source);
        await context.lookup("uploader.disk.yandex.net");
        if (request.body === undefined) {
          throw new Error("missing upload body");
        }
        for await (const chunk of request.body) {
          directBodies.push(Uint8Array.from(chunk));
        }
        return emptyDirectResponse(201);
      },
    );
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );
    const params = uploadParams(source);

    const result = await executor.execute("tool-call-upload-1", params);

    expect(deps.proxyClient.request).toHaveBeenCalledWith({
      providerConfigKey: "yandex-disk",
      operationKind: "read",
      method: "GET",
      path: "v1/disk/resources/upload",
      query: [
        { name: "path", value: "disk:/folder/file.bin" },
        { name: "overwrite", value: "false" },
      ],
      timeoutMs: expect.any(Number),
    });
    expect(deps.transferTransport.request).toHaveBeenCalledOnce();
    expect(deps.dnsLookup).toHaveBeenCalledTimes(2);
    expect(
      Buffer.concat(directBodies.map((chunk) => Buffer.from(chunk))),
    ).toEqual(Buffer.from(payload));
    expect(result).toMatchObject({
      ok: true,
      response: {
        body: {
          direction: "upload",
          size: payload.byteLength,
          sha256: createHash("sha256").update(payload).digest("hex"),
        },
      },
      outcome: "confirmed",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(source);
    expect(serialized).not.toContain("disk:/folder");
    expect(serialized).not.toContain("uploader.disk.yandex.net");
    expect(serialized).not.toContain(PROOF_SENTINEL);
    expect(serialized).not.toContain(CLOUDRU_SENTINEL);
  });

  test("rejects non-exact link metadata without direct DNS or transfer I/O", async () => {
    const roots = await temporaryRoots();
    const source = path.join(roots.uploadRoot, "source.bin");
    await writeFile(source, "payload");
    const deps = dependencies();
    deps.proxyClient.request.mockResolvedValue({
      ok: true,
      request: {
        providerConfigKey: "yandex-disk",
        method: "GET",
        path: "v1/disk/resources/upload",
      },
      response: {
        status: 200,
        contentType: "application/json",
        headers: {},
        body: {
          href: "https://uploader.disk.yandex.net/token",
          method: "PUT",
          templated: false,
          injectedSecret: "provider-body-secret",
        },
      },
      outcome: "confirmed",
    });
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-upload-2",
      uploadParams(source),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        layer: "unknown_upstream",
        code: "invalid_transfer_link",
      },
      outcome: "not_started",
    });
    expect(deps.dnsLookup).not.toHaveBeenCalled();
    expect(deps.transferTransport.request).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("provider-body-secret");
  });

  test("rejects an oversized opened source before link acquisition", async () => {
    const roots = await temporaryRoots();
    const source = path.join(roots.uploadRoot, "source.bin");
    await writeFile(source, Uint8Array.from([1, 2, 3, 4, 5]));
    const deps = dependencies();
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot, {
        maxTransferBytes: 4,
      }),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-upload-3",
      uploadParams(source),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { layer: "local_io", code: "transfer_too_large" },
      outcome: "not_started",
    });
    expect(deps.proxyClient.request).not.toHaveBeenCalled();
    expect(deps.transferTransport.request).not.toHaveBeenCalled();
  });

  test("does not retry an ambiguous dispatched upload network failure", async () => {
    const roots = await temporaryRoots();
    const source = path.join(roots.uploadRoot, "source.bin");
    await writeFile(source, "payload");
    const sentinel = "direct-network-error-secret";
    const deps = dependencies();
    deps.transferTransport.request.mockImplementation(
      async (_request, context) => {
        await context.lookup("uploader.disk.yandex.net");
        throw new Error(sentinel);
      },
    );
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-upload-4",
      uploadParams(source),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        layer: "network",
        code: "transfer_network_error",
        retryable: false,
      },
      outcome: "unknown",
    });
    expect(deps.transferTransport.request).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  test("treats a success response without a completely consumed body as unknown", async () => {
    const roots = await temporaryRoots();
    const source = path.join(roots.uploadRoot, "source.bin");
    await writeFile(source, "payload");
    const deps = dependencies();
    deps.transferTransport.request.mockImplementation(
      async (_request, context) => {
        await context.lookup("uploader.disk.yandex.net");
        return emptyDirectResponse(201);
      },
    );
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-upload-5",
      uploadParams(source),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "upload_incomplete" },
      outcome: "unknown",
    });
    expect(deps.transferTransport.request).toHaveBeenCalledOnce();
  });
});

describe("download streaming and atomic publication", () => {
  test("streams a credential-free GET into an exclusive temp and atomically publishes it", async () => {
    const roots = await temporaryRoots();
    const destination = path.join(roots.downloadRoot, "download.bin");
    const payload = new TextEncoder().encode("streamed-download-payload");
    const deps = dependencies();
    deps.proxyClient.request.mockResolvedValue({
      ok: true,
      request: {
        providerConfigKey: "yandex-disk",
        method: "GET",
        path: "v1/disk/resources/download",
      },
      response: {
        status: 200,
        contentType: "application/json",
        headers: {},
        body: {
          href: "https://downloader.disk.yandex.ru/download-token",
          method: "GET",
          templated: false,
        },
      },
      outcome: "confirmed",
    });
    deps.transferTransport.request.mockImplementation(
      async (request, context) => {
        expect(request.url).toBe(
          "https://downloader.disk.yandex.ru/download-token",
        );
        expect(request.method).toBe("GET");
        expect(request.headers).toEqual({});
        expect(request.body).toBeUndefined();
        expect(JSON.stringify(request)).not.toContain(PROOF_SENTINEL);
        expect(JSON.stringify(request)).not.toContain(CLOUDRU_SENTINEL);
        expect(JSON.stringify(request)).not.toContain(destination);
        await context.lookup("downloader.disk.yandex.ru");
        return streamedDirectResponse([
          payload.subarray(0, 7),
          payload.subarray(7),
        ]);
      },
    );
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-download-1",
      downloadParams(destination),
    );

    expect(deps.proxyClient.request).toHaveBeenCalledWith({
      providerConfigKey: "yandex-disk",
      operationKind: "read",
      method: "GET",
      path: "v1/disk/resources/download",
      query: [{ name: "path", value: "disk:/folder/file.bin" }],
      timeoutMs: expect.any(Number),
    });
    expect(await readFile(destination)).toEqual(Buffer.from(payload));
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect(await readdir(roots.downloadRoot)).toEqual(["download.bin"]);
    expect(result).toMatchObject({
      ok: true,
      response: {
        body: {
          direction: "download",
          size: payload.byteLength,
          sha256: createHash("sha256").update(payload).digest("hex"),
        },
      },
      outcome: "confirmed",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(destination);
    expect(serialized).not.toContain("disk:/folder");
    expect(serialized).not.toContain("downloader.disk.yandex.ru");
    expect(serialized).not.toContain(PROOF_SENTINEL);
  });

  test("keeps an existing destination unchanged when overwrite is false", async () => {
    const roots = await temporaryRoots();
    const destination = path.join(roots.downloadRoot, "existing.bin");
    await writeFile(destination, "original");
    const deps = dependencies();
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-download-2",
      downloadParams(destination),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "destination_exists" },
      outcome: "not_started",
    });
    expect(await readFile(destination, "utf8")).toBe("original");
    expect(deps.proxyClient.request).not.toHaveBeenCalled();
    expect(deps.transferTransport.request).not.toHaveBeenCalled();
  });

  test("atomically replaces a regular destination only when overwrite is true", async () => {
    const roots = await temporaryRoots();
    const destination = path.join(roots.downloadRoot, "existing.bin");
    await writeFile(destination, "original");
    const payload = new TextEncoder().encode("replacement");
    const deps = dependencies();
    deps.proxyClient.request.mockResolvedValue({
      ok: true,
      request: {
        providerConfigKey: "yandex-disk",
        method: "GET",
        path: "v1/disk/resources/download",
      },
      response: {
        status: 200,
        contentType: "application/json",
        headers: {},
        body: {
          href: "https://downloader.disk.yandex.net/token",
        },
      },
      outcome: "confirmed",
    });
    deps.transferTransport.request.mockImplementation(
      async (_request, context) => {
        await context.lookup("downloader.disk.yandex.net");
        return streamedDirectResponse([payload]);
      },
    );
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute("tool-call-download-3", {
      ...downloadParams(destination),
      overwrite: true,
    });

    expect(result).toMatchObject({ ok: true });
    expect(await readFile(destination, "utf8")).toBe("replacement");
    expect(await readdir(roots.downloadRoot)).toEqual(["existing.bin"]);
  });

  test("cleans the temp and preserves the destination after a stream failure", async () => {
    const roots = await temporaryRoots();
    const destination = path.join(roots.downloadRoot, "failed.bin");
    const sentinel = "download-stream-secret";
    const deps = dependencies();
    deps.proxyClient.request.mockResolvedValue({
      ok: true,
      request: {
        providerConfigKey: "yandex-disk",
        method: "GET",
        path: "v1/disk/resources/download",
      },
      response: {
        status: 200,
        contentType: "application/json",
        headers: {},
        body: {
          href: "https://downloader.disk.yandex.net/token",
        },
      },
      outcome: "confirmed",
    });
    deps.transferTransport.request.mockImplementation(
      async (_request, context) => {
        await context.lookup("downloader.disk.yandex.net");
        const response = streamedDirectResponse([]);
        return {
          ...response,
          body: (async function* () {
            yield new TextEncoder().encode("partial");
            throw new Error(sentinel);
          })(),
        };
      },
    );
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-download-4",
      downloadParams(destination),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        layer: "network",
        code: "transfer_stream_error",
      },
      outcome: "confirmed_failed",
    });
    expect(await readdir(roots.downloadRoot)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(JSON.stringify(result)).not.toContain("partial");
  });

  test("stops at cap plus one, cancels, and removes the temp without a digest", async () => {
    const roots = await temporaryRoots();
    const destination = path.join(roots.downloadRoot, "oversized.bin");
    const deps = dependencies();
    deps.proxyClient.request.mockResolvedValue({
      ok: true,
      request: {
        providerConfigKey: "yandex-disk",
        method: "GET",
        path: "v1/disk/resources/download",
      },
      response: {
        status: 200,
        contentType: "application/json",
        headers: {},
        body: {
          href: "https://downloader.disk.yandex.net/token",
        },
      },
      outcome: "confirmed",
    });
    const response = streamedDirectResponse([
      Uint8Array.from([1, 2, 3, 4]),
      Uint8Array.from([5]),
      new TextEncoder().encode("must-not-be-read"),
    ]);
    deps.transferTransport.request.mockImplementation(
      async (_request, context) => {
        await context.lookup("downloader.disk.yandex.net");
        return response;
      },
    );
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot, {
        maxTransferBytes: 4,
      }),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-download-5",
      downloadParams(destination),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "transfer_too_large" },
      outcome: "confirmed_failed",
    });
    expect(response.cancel).toHaveBeenCalled();
    expect(await readdir(roots.downloadRoot)).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("sha256");
    expect(JSON.stringify(result)).not.toContain("must-not-be-read");
  });

  test("returns capability_unavailable when download link metadata is unavailable", async () => {
    const roots = await temporaryRoots();
    const destination = path.join(roots.downloadRoot, "download.bin");
    const deps = dependencies();
    deps.proxyClient.request.mockResolvedValue({
      ok: true,
      request: {
        providerConfigKey: "yandex-disk",
        method: "GET",
        path: "v1/disk/resources/download",
      },
      response: {
        status: 200,
        contentType: "application/json",
        headers: {},
        body: {},
      },
      outcome: "confirmed",
    });
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-download-6",
      downloadParams(destination),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "capability_unavailable" },
      outcome: "not_started",
    });
    expect(deps.dnsLookup).not.toHaveBeenCalled();
    expect(deps.transferTransport.request).not.toHaveBeenCalled();
    expect(await readdir(roots.downloadRoot)).toEqual([]);
  });

  test("does not clobber a destination created during the download", async () => {
    const roots = await temporaryRoots();
    const destination = path.join(roots.downloadRoot, "raced.bin");
    const deps = dependencies();
    deps.proxyClient.request.mockResolvedValue({
      ok: true,
      request: {
        providerConfigKey: "yandex-disk",
        method: "GET",
        path: "v1/disk/resources/download",
      },
      response: {
        status: 200,
        contentType: "application/json",
        headers: {},
        body: {
          href: "https://downloader.disk.yandex.net/token",
        },
      },
      outcome: "confirmed",
    });
    deps.transferTransport.request.mockImplementation(
      async (_request, context) => {
        await context.lookup("downloader.disk.yandex.net");
        return {
          ...streamedDirectResponse([]),
          body: (async function* () {
            yield new TextEncoder().encode("downloaded");
            await writeFile(destination, "racer");
          })(),
        };
      },
    );
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-download-7",
      downloadParams(destination),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "destination_exists" },
      outcome: "confirmed_failed",
    });
    expect(await readFile(destination, "utf8")).toBe("racer");
    expect(await readdir(roots.downloadRoot)).toEqual(["raced.bin"]);
  });
});

describe("transfer URL, DNS, and redirect safety", () => {
  test.each([
    "http://uploader.disk.yandex.net/token",
    "https://user@uploader.disk.yandex.net/token",
    "https://uploader.disk.yandex.net:8443/token",
    "https://uploader.disk.yandex.net/token#fragment",
    "https://uploader.disk.yandex.net.attacker.example/token",
    "https://disk.yandex.net.evil.example/token",
    "/relative-transfer-link",
  ])("rejects unsafe transfer URL %s before DNS or direct I/O", async (href) => {
    const roots = await temporaryRoots();
    const source = path.join(roots.uploadRoot, "source.bin");
    await writeFile(source, "payload");
    const deps = dependencies();
    mockTransferLink(deps, href, "PUT");
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-unsafe-url",
      uploadParams(source),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsafe_transfer_url" },
      outcome: "not_started",
    });
    expect(deps.dnsLookup).not.toHaveBeenCalled();
    expect(deps.transferTransport.request).not.toHaveBeenCalled();
  });

  test.each([
    ["0.0.0.0", 4],
    ["10.1.2.3", 4],
    ["100.64.1.2", 4],
    ["127.0.0.1", 4],
    ["169.254.1.1", 4],
    ["172.16.1.1", 4],
    ["192.168.1.1", 4],
    ["192.0.2.10", 4],
    ["198.51.100.10", 4],
    ["203.0.113.10", 4],
    ["224.0.0.1", 4],
    ["::", 6],
    ["::1", 6],
    ["::ffff:127.0.0.1", 6],
    ["::ffff:8.8.8.8", 6],
    ["fc00::1", 6],
    ["fe80::1", 6],
    ["ff02::1", 6],
    ["2001::1", 6],
    ["2001:db8::1", 6],
    ["2002::1", 6],
    ["2620:4f:8000::1", 6],
    ["3ffe::1", 6],
    ["3fff::1", 6],
  ] as const)(
    "rejects non-public resolved address %s",
    async (address, family) => {
      const roots = await temporaryRoots();
      const source = path.join(roots.uploadRoot, "source.bin");
      await writeFile(source, "payload");
      const deps = dependencies({
        dnsLookup: vi.fn(async () => [{ address, family }]),
      });
      const executor = createDiskTransferExecutor(
        runtimeConfig(roots.uploadRoot, roots.downloadRoot),
        deps.value,
      );

      const result = await executor.execute(
        "tool-call-unsafe-address",
        uploadParams(source),
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: "unsafe_transfer_address" },
        outcome: "not_started",
      });
      expect(deps.transferTransport.request).not.toHaveBeenCalled();
    },
  );

  test("accepts public IPv6 and a configured dst.yandex.net transfer host", async () => {
    const roots = await temporaryRoots();
    const source = path.join(roots.uploadRoot, "source.bin");
    await writeFile(source, "payload");
    const dnsLookup = vi.fn(async () => [
      { address: "2a02:6b8::1", family: 6 as const },
    ]);
    const deps = dependencies({ dnsLookup });
    mockTransferLink(
      deps,
      "https://uploader.dst.yandex.net/token",
      "PUT",
    );
    deps.transferTransport.request.mockImplementation(
      async (request, context) => {
        await context.lookup("uploader.dst.yandex.net");
        if (request.body === undefined) {
          throw new Error("missing upload body");
        }
        for await (const _chunk of request.body) {
          // Consume the stream to prove the complete transfer.
        }
        return emptyDirectResponse(201);
      },
    );
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-public-ipv6",
      uploadParams(source),
    );

    expect(result).toMatchObject({ ok: true });
    expect(dnsLookup).toHaveBeenCalledTimes(2);
  });

  test("rejects a mixed public/private DNS answer and a rebinding lookup", async () => {
    const roots = await temporaryRoots();
    const source = path.join(roots.uploadRoot, "source.bin");
    await writeFile(source, "payload");

    const mixed = dependencies({
      dnsLookup: vi.fn(async () => [
        { address: "77.88.8.8", family: 4 as const },
        { address: "127.0.0.1", family: 4 as const },
      ]),
    });
    const mixedExecutor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      mixed.value,
    );
    const mixedResult = await mixedExecutor.execute(
      "tool-call-mixed-dns",
      uploadParams(source),
    );

    expect(mixedResult).toMatchObject({
      ok: false,
      error: { code: "unsafe_transfer_address" },
      outcome: "not_started",
    });
    expect(mixed.transferTransport.request).not.toHaveBeenCalled();

    const rebindingLookup = vi
      .fn()
      .mockResolvedValueOnce([
        { address: "77.88.8.8", family: 4 as const },
      ])
      .mockResolvedValueOnce([
        { address: "127.0.0.1", family: 4 as const },
      ]);
    let bodyConsumed = false;
    const rebound = dependencies({ dnsLookup: rebindingLookup });
    rebound.transferTransport.request.mockImplementation(
      async (request, context) => {
        await context.lookup("uploader.disk.yandex.net");
        if (request.body !== undefined) {
          for await (const _chunk of request.body) {
            bodyConsumed = true;
          }
        }
        return emptyDirectResponse(201);
      },
    );
    const reboundExecutor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      rebound.value,
    );
    const reboundResult = await reboundExecutor.execute(
      "tool-call-rebinding-dns",
      uploadParams(source),
    );

    expect(reboundResult).toMatchObject({
      ok: false,
      error: { code: "transfer_network_error" },
      outcome: "unknown",
    });
    expect(rebindingLookup).toHaveBeenCalledTimes(2);
    expect(bodyConsumed).toBe(false);
  });

  test("follows only method-preserving upload redirects and revalidates every hop", async () => {
    const roots = await temporaryRoots();
    const source = path.join(roots.uploadRoot, "source.bin");
    const payload = new TextEncoder().encode("redirected-upload");
    await writeFile(source, payload);
    const deps = dependencies();
    const firstResponse = emptyDirectResponse(307, {
      location: "https://uploader.dst.yandex.net/final-token",
    });
    const finalResponse = emptyDirectResponse(201);
    deps.transferTransport.request
      .mockImplementationOnce(async (request, context) => {
        await context.lookup("uploader.disk.yandex.net");
        if (request.body === undefined) {
          throw new Error("missing upload body");
        }
        for await (const _chunk of request.body) {
          // Fully dispatch the first method-preserving request.
        }
        return firstResponse;
      })
      .mockImplementationOnce(async (request, context) => {
        expect(request.url).toBe(
          "https://uploader.dst.yandex.net/final-token",
        );
        await context.lookup("uploader.dst.yandex.net");
        if (request.body === undefined) {
          throw new Error("missing upload body");
        }
        const chunks: Uint8Array[] = [];
        for await (const chunk of request.body) {
          chunks.push(Uint8Array.from(chunk));
        }
        expect(Buffer.concat(chunks.map(Buffer.from))).toEqual(
          Buffer.from(payload),
        );
        return finalResponse;
      });
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-upload-redirect",
      uploadParams(source),
    );

    expect(result).toMatchObject({ ok: true });
    expect(deps.transferTransport.request).toHaveBeenCalledTimes(2);
    expect(deps.dnsLookup).toHaveBeenCalledTimes(4);
    expect(firstResponse.cancel).toHaveBeenCalled();
    expect(firstResponse.close).toHaveBeenCalled();
  });

  test.each([301, 302, 303])(
    "rejects method-changing upload redirect %s without replay",
    async (status) => {
      const roots = await temporaryRoots();
      const source = path.join(roots.uploadRoot, "source.bin");
      await writeFile(source, "payload");
      const deps = dependencies();
      deps.transferTransport.request.mockImplementation(
        async (request, context) => {
          await context.lookup("uploader.disk.yandex.net");
          if (request.body === undefined) {
            throw new Error("missing upload body");
          }
          for await (const _chunk of request.body) {
            // Fully dispatch before the unsafe redirect response.
          }
          return emptyDirectResponse(status, {
            location: "https://uploader.disk.yandex.net/replayed",
          });
        },
      );
      const executor = createDiskTransferExecutor(
        runtimeConfig(roots.uploadRoot, roots.downloadRoot),
        deps.value,
      );

      const result = await executor.execute(
        `tool-call-upload-redirect-${status}`,
        uploadParams(source),
      );

      expect(result).toMatchObject({
        ok: false,
        error: { code: "unsafe_redirect" },
        outcome: "unknown",
      });
      expect(deps.transferTransport.request).toHaveBeenCalledOnce();
    },
  );

  test("enforces the redirect cap and never follows an arbitrary host", async () => {
    const roots = await temporaryRoots();
    const source = path.join(roots.uploadRoot, "source.bin");
    await writeFile(source, "payload");
    const deps = dependencies();
    deps.transferTransport.request.mockImplementation(
      async (request, context) => {
        await context.lookup(new URL(request.url).hostname);
        if (request.body === undefined) {
          throw new Error("missing upload body");
        }
        for await (const _chunk of request.body) {
          // Fully dispatch the request.
        }
        const location =
          deps.transferTransport.request.mock.calls.length === 1
            ? "https://uploader.disk.yandex.net/second"
            : "https://attacker.example/final";
        return emptyDirectResponse(307, { location });
      },
    );
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot, {
        maxRedirects: 1,
      }),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-redirect-cap",
      uploadParams(source),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "redirect_limit_exceeded" },
      outcome: "unknown",
    });
    expect(deps.transferTransport.request).toHaveBeenCalledTimes(2);
    expect(deps.dnsLookup).toHaveBeenCalledTimes(4);
  });

  test("rejects an arbitrary public HTTPS redirect before another request", async () => {
    const roots = await temporaryRoots();
    const source = path.join(roots.uploadRoot, "source.bin");
    await writeFile(source, "payload");
    const deps = dependencies();
    deps.transferTransport.request.mockImplementation(
      async (request, context) => {
        await context.lookup("uploader.disk.yandex.net");
        if (request.body === undefined) {
          throw new Error("missing upload body");
        }
        for await (const _chunk of request.body) {
          // Fully dispatch before receiving the redirect.
        }
        return emptyDirectResponse(307, {
          location: "https://attacker.example/token",
        });
      },
    );
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-arbitrary-redirect",
      uploadParams(source),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsafe_transfer_url" },
      outcome: "unknown",
    });
    expect(deps.transferTransport.request).toHaveBeenCalledOnce();
    expect(deps.dnsLookup).toHaveBeenCalledTimes(2);
  });

  test("follows a bounded download redirect before creating the temp file", async () => {
    const roots = await temporaryRoots();
    const destination = path.join(roots.downloadRoot, "redirected.bin");
    const payload = new TextEncoder().encode("redirected-download");
    const deps = dependencies();
    mockTransferLink(
      deps,
      "https://downloader.disk.yandex.ru/first",
      "GET",
    );
    const redirectResponse = emptyDirectResponse(302, {
      location: "https://downloader.dst.yandex.net/final",
    });
    deps.transferTransport.request
      .mockImplementationOnce(async (_request, context) => {
        await context.lookup("downloader.disk.yandex.ru");
        return redirectResponse;
      })
      .mockImplementationOnce(async (request, context) => {
        expect(request.url).toBe(
          "https://downloader.dst.yandex.net/final",
        );
        await context.lookup("downloader.dst.yandex.net");
        return streamedDirectResponse([payload]);
      });
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-download-redirect",
      downloadParams(destination),
    );

    expect(result).toMatchObject({ ok: true });
    expect(await readFile(destination)).toEqual(Buffer.from(payload));
    expect(deps.dnsLookup).toHaveBeenCalledTimes(4);
    expect(redirectResponse.cancel).toHaveBeenCalled();
    expect(redirectResponse.close).toHaveBeenCalled();
  });
});

describe("total deadline and destination revalidation", () => {
  test("times out one hanging link acquisition before direct I/O", async () => {
    const roots = await temporaryRoots();
    const source = path.join(roots.uploadRoot, "source.bin");
    await writeFile(source, "payload");
    let fireTimeout = () => undefined;
    const clearTimer = vi.fn();
    const deps = dependencies({
      setTimer: (callback) => {
        fireTimeout = callback;
        return "timer";
      },
      clearTimer,
    });
    deps.proxyClient.request.mockImplementation(
      async () => new Promise<never>(() => undefined),
    );
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot, {
        timeoutMs: 20,
      }),
      deps.value,
    );
    const pending = executor.execute("tool-call-link-timeout", {
      ...uploadParams(source),
      timeoutMs: 20,
    });

    await vi.waitFor(() => {
      expect(deps.proxyClient.request).toHaveBeenCalledOnce();
    });
    fireTimeout();
    const result = await pending;

    expect(result).toMatchObject({
      ok: false,
      error: { code: "transfer_timeout" },
      outcome: "not_started",
    });
    expect(deps.proxyClient.request).toHaveBeenCalledOnce();
    expect(deps.transferTransport.request).not.toHaveBeenCalled();
    expect(clearTimer).toHaveBeenCalledWith("timer");
  });

  test("aborts a stalled download stream and removes its partial temp", async () => {
    const roots = await temporaryRoots();
    const destination = path.join(roots.downloadRoot, "stalled.bin");
    let fireTimeout = () => undefined;
    const clearTimer = vi.fn();
    const deps = dependencies({
      setTimer: (callback) => {
        fireTimeout = callback;
        return "timer";
      },
      clearTimer,
    });
    mockTransferLink(
      deps,
      "https://downloader.disk.yandex.net/token",
      "GET",
    );
    const response = streamedDirectResponse([]);
    deps.transferTransport.request.mockImplementation(
      async (_request, context) => {
        await context.lookup("downloader.disk.yandex.net");
        return {
          ...response,
          body: (async function* () {
            yield new TextEncoder().encode("partial");
            await new Promise<never>(() => undefined);
          })(),
        };
      },
    );
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot, {
        timeoutMs: 20,
      }),
      deps.value,
    );
    const pending = executor.execute("tool-call-stream-timeout", {
      ...downloadParams(destination),
      timeoutMs: 20,
    });

    await vi.waitFor(async () => {
      expect(await readdir(roots.downloadRoot)).toEqual([
        expect.stringMatching(/^\.nango-download-/),
      ]);
    });
    fireTimeout();
    const result = await pending;

    expect(result).toMatchObject({
      ok: false,
      error: { code: "transfer_timeout" },
      outcome: "confirmed_failed",
    });
    expect(response.cancel).toHaveBeenCalled();
    expect(await readdir(roots.downloadRoot)).toEqual([]);
    expect(clearTimer).toHaveBeenCalledWith("timer");
  });

  test("revalidates the destination parent after network I/O and before temp creation", async () => {
    const roots = await temporaryRoots();
    const originalParent = path.join(roots.downloadRoot, "nested");
    const movedParent = path.join(roots.downloadRoot, "nested-moved");
    const outside = path.join(roots.base, "outside");
    await mkdir(originalParent);
    await mkdir(outside);
    const destination = path.join(originalParent, "download.bin");
    const deps = dependencies();
    mockTransferLink(
      deps,
      "https://downloader.disk.yandex.net/token",
      "GET",
    );
    deps.transferTransport.request.mockImplementation(
      async (_request, context) => {
        await context.lookup("downloader.disk.yandex.net");
        await rename(originalParent, movedParent);
        await symlink(outside, originalParent);
        return streamedDirectResponse([
          new TextEncoder().encode("must-not-escape"),
        ]);
      },
    );
    const executor = createDiskTransferExecutor(
      runtimeConfig(roots.uploadRoot, roots.downloadRoot),
      deps.value,
    );

    const result = await executor.execute(
      "tool-call-parent-race",
      downloadParams(destination),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: "unsafe_local_path" },
      outcome: "confirmed_failed",
    });
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(movedParent)).toEqual([]);
  });
});
