import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
import { promises as dnsPromises } from "node:dns";
import { constants as fsConstants } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { isIP, type LookupFunction } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";

import { Client } from "undici";

import { APPROVAL_PROOF_PARAM } from "../approval.js";
import type { RuntimeConfig } from "../config.js";
import type { ProxyClient } from "../proxy-client.js";
import {
  createFailureResult,
  createSuccessResult,
  type ErrorLayer,
  type FailureResult,
  type FailureOutcome,
  type ToolResult,
} from "../result.js";

const MAX_PATH_BYTES = 4_096;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const TOOL_NAME = "nango_disk_transfer";
const RESULT_REQUEST = Object.freeze({
  providerConfigKey: "yandex-disk" as const,
  method: "POST" as const,
  path: "disk-transfer",
});
const PARAM_KEYS = new Set([
  "providerConfigKey",
  "direction",
  "operation",
  "localPath",
  "remotePath",
  "overwrite",
  "timeoutMs",
  APPROVAL_PROOF_PARAM,
]);

type Direction = "upload" | "download";

export type ResolvedAddress = Readonly<{
  address: string;
  family: 4 | 6;
}>;

export type DirectTransferRequest = Readonly<{
  url: string;
  method: "GET" | "PUT";
  headers: Readonly<Record<string, string>>;
  body?: AsyncIterable<Uint8Array>;
  signal: AbortSignal;
}>;

export type DirectTransferResponse = Readonly<{
  status: number;
  headers: Headers;
  body: AsyncIterable<Uint8Array>;
  cancel(): Promise<void> | void;
  close(): Promise<void> | void;
}>;

export type DirectTransferTransport = Readonly<{
  request(
    request: DirectTransferRequest,
    context: Readonly<{
      lookup(hostname: string): Promise<readonly ResolvedAddress[]>;
      maxResponseBytes: number;
      timeoutMs: number;
    }>,
  ): Promise<DirectTransferResponse>;
}>;

export type DiskFileStats = Readonly<{
  dev: number | bigint;
  ino: number | bigint;
  mode: number;
  uid: number;
  size: number | bigint;
  mtimeMs: number;
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
}>;

export type DiskFileHandle = Readonly<{
  stat(): Promise<DiskFileStats>;
  createReadStream(options: {
    autoClose: false;
    start: number;
  }): AsyncIterable<Uint8Array> & {
    destroy(error?: Error): void;
  };
  write(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}>;

export type DiskFileSystem = Readonly<{
  lstat(localPath: string): Promise<DiskFileStats>;
  realpath(localPath: string): Promise<string>;
  open(
    localPath: string,
    flags: number,
    mode?: number,
  ): Promise<DiskFileHandle>;
  rename(oldPath: string, newPath: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(localPath: string): Promise<void>;
}>;

type ApprovalResult =
  | Readonly<{ ok: true; operationKind: "read" | "mutation" }>
  | Readonly<{ ok: false; code: string }>;

export type DiskTransferDependencies = Readonly<{
  approvalVerifier: Readonly<{
    verifyAndConsume(
      toolName: string,
      toolCallId: string,
      params: unknown,
    ): ApprovalResult;
  }>;
  proxyClient: Pick<ProxyClient, "request">;
  transferTransport?: DirectTransferTransport;
  dnsLookup?(
    hostname: string,
  ): Promise<readonly ResolvedAddress[]>;
  fileSystem?: DiskFileSystem;
  monotonicNow?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  randomBytes?: (size: number) => Uint8Array;
}>;

type ResolvedDiskTransferDependencies =
  Omit<DiskTransferDependencies, "dnsLookup" | "transferTransport"> &
  Readonly<{
    transferTransport: DirectTransferTransport;
    dnsLookup(
      hostname: string,
    ): Promise<readonly ResolvedAddress[]>;
  }>;

export type DiskTransferExecutor = Readonly<{
  execute(toolCallId: string, params: unknown): Promise<ToolResult>;
}>;

type NormalizedParams = Readonly<{
  direction: Direction;
  localPath: string;
  remotePath: string;
  overwrite: boolean;
  timeoutMs?: number;
  raw: Record<string, unknown>;
}>;

type ResolvedLocalPath = Readonly<{
  root: string;
  candidate: string;
}>;

class DiskTransferError extends Error {
  readonly layer: ErrorLayer;
  readonly code: string;
  readonly outcome: FailureOutcome;
  readonly status?: number;

  constructor(
    layer: DiskTransferError["layer"],
    code: string,
    outcome: DiskTransferError["outcome"] = "not_started",
    status?: number,
  ) {
    super(code);
    this.name = "DiskTransferError";
    this.layer = layer;
    this.code = code;
    this.outcome = outcome;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

class OperationTimeoutError extends Error {}
class TransferTooLargeError extends Error {}

const DEFAULT_FILE_SYSTEM: DiskFileSystem = {
  lstat: (localPath) => fsPromises.lstat(localPath),
  realpath: (localPath) => fsPromises.realpath(localPath),
  open: async (localPath, flags, mode) =>
    mode === undefined
      ? fsPromises.open(localPath, flags)
      : fsPromises.open(localPath, flags, mode),
  rename: (oldPath, newPath) => fsPromises.rename(oldPath, newPath),
  link: (existingPath, newPath) =>
    fsPromises.link(existingPath, newPath),
  unlink: (localPath) => fsPromises.unlink(localPath),
};

function lookupError(): NodeJS.ErrnoException {
  return Object.assign(new Error("Pinned transfer DNS lookup failed"), {
    code: "ENOTFOUND",
  });
}

function pinnedLookup(
  expectedHostname: string,
  addresses: readonly ResolvedAddress[],
): LookupFunction {
  return (hostname, options, callback) => {
    if (hostname.toLowerCase() !== expectedHostname) {
      callback(lookupError(), "", 0);
      return;
    }
    const requestedFamily =
      options.family === "IPv4"
        ? 4
        : options.family === "IPv6"
          ? 6
          : options.family;
    const eligible =
      requestedFamily === 4 || requestedFamily === 6
        ? addresses.filter(
            (address) => address.family === requestedFamily,
          )
        : addresses;
    const selected = eligible[0];
    if (selected === undefined) {
      callback(lookupError(), "", 0);
      return;
    }
    if (options.all) {
      callback(
        null,
        eligible.map((address) => ({
          address: address.address,
          family: address.family,
        })),
      );
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

function responseHeaders(
  rawHeaders: Readonly<Record<string, string | string[] | undefined>>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else if (value !== undefined) {
      headers.append(name, value);
    }
  }
  return headers;
}

export function createUndiciTransferTransport(): DirectTransferTransport {
  return Object.freeze({
    async request(request, context) {
      const url = new URL(request.url);
      const addresses = await context.lookup(url.hostname);
      const client = new Client(url.origin, {
        allowH2: false,
        pipelining: 1,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: Math.min(
          250,
          context.timeoutMs,
        ),
        maxRequestsPerClient: 1,
        maxHeaderSize: 16_384,
        maxResponseSize: context.maxResponseBytes,
        connectTimeout: context.timeoutMs,
        headersTimeout: context.timeoutMs,
        bodyTimeout: context.timeoutMs,
        connect: {
          lookup: pinnedLookup(url.hostname, addresses),
          servername: url.hostname,
          timeout: context.timeoutMs,
        },
      });
      const body =
        request.body === undefined
          ? undefined
          : Readable.from(request.body, { objectMode: false });
      try {
        const response = await client.request({
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers: request.headers,
          ...(body === undefined ? {} : { body }),
          signal: request.signal,
          idempotent: false,
          blocking: true,
          headersTimeout: context.timeoutMs,
          bodyTimeout: context.timeoutMs,
        });
        let closed = false;
        return Object.freeze({
          status: response.statusCode,
          headers: responseHeaders(response.headers),
          body: response.body,
          cancel() {
            response.body.destroy();
          },
          async close() {
            if (closed) {
              return;
            }
            closed = true;
            await client.destroy();
          },
        });
      } catch (error) {
        body?.destroy();
        try {
          await client.destroy();
        } catch {
          // Preserve the request error and never surface transport internals.
        }
        throw error;
      }
    },
  });
}

export async function lookupDiskTransferAddresses(
  hostname: string,
): Promise<readonly ResolvedAddress[]> {
  const records = await dnsPromises.lookup(hostname, {
    all: true,
    verbatim: true,
  });
  return records.map((record) => {
    if (record.family !== 4 && record.family !== 6) {
      throw lookupError();
    }
    return Object.freeze({
      address: record.address,
      family: record.family,
    });
  });
}

const DEFAULT_TRANSFER_TRANSPORT = createUndiciTransferTransport();

export function createDefaultDiskTransferNetworkDependencies(): Readonly<{
  transferTransport: DirectTransferTransport;
  dnsLookup: typeof lookupDiskTransferAddresses;
}> {
  return Object.freeze({
    transferTransport: DEFAULT_TRANSFER_TRANSPORT,
    dnsLookup: lookupDiskTransferAddresses,
  });
}

function isPlainDataRecord(
  value: unknown,
): value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return (
      descriptor !== undefined &&
      descriptor.enumerable &&
      Object.hasOwn(descriptor, "value")
    );
  });
}

function validPathValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_PATH_BYTES &&
    !CONTROL_RE.test(value)
  );
}

function normalizeParams(
  config: RuntimeConfig,
  value: unknown,
): NormalizedParams {
  if (
    !isPlainDataRecord(value) ||
    Object.keys(value).some((key) => !PARAM_KEYS.has(key)) ||
    value.providerConfigKey !== "yandex-disk" ||
    !validPathValue(value.localPath) ||
    !validPathValue(value.remotePath) ||
    (value.overwrite !== undefined &&
      typeof value.overwrite !== "boolean")
  ) {
    throw new DiskTransferError(
      "validation",
      "invalid_disk_transfer",
    );
  }
  const direction =
    typeof value.direction === "string"
      ? value.direction
      : value.operation;
  if (
    (direction !== "upload" && direction !== "download") ||
    (value.direction !== undefined &&
      value.operation !== undefined &&
      value.direction !== value.operation)
  ) {
    throw new DiskTransferError(
      "validation",
      "invalid_disk_transfer",
    );
  }
  if (
    value.timeoutMs !== undefined &&
    (!Number.isSafeInteger(value.timeoutMs) ||
      (value.timeoutMs as number) < 1 ||
      config.disk === undefined ||
      (value.timeoutMs as number) > config.disk.timeoutMs)
  ) {
    throw new DiskTransferError(
      "validation",
      "invalid_disk_transfer",
    );
  }
  return Object.freeze({
    direction,
    localPath: value.localPath,
    remotePath: value.remotePath,
    overwrite: value.overwrite ?? false,
    ...(value.timeoutMs === undefined
      ? {}
      : { timeoutMs: value.timeoutMs as number }),
    raw: value,
  });
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function resolveLocalPath(
  roots: readonly string[],
  localPath: string,
): ResolvedLocalPath {
  if (roots.length === 0) {
    throw new DiskTransferError(
      "validation",
      "capability_unavailable",
    );
  }
  if (!path.isAbsolute(localPath)) {
    if (
      localPath.includes("\\") ||
      localPath.split("/").some(
        (segment) => segment === "" || segment === "." || segment === "..",
      )
    ) {
      throw new DiskTransferError(
        "validation",
        "invalid_local_path",
      );
    }
    if (roots.length !== 1) {
      throw new DiskTransferError(
        "validation",
        "ambiguous_local_path",
      );
    }
    const root = roots[0];
    if (root === undefined) {
      throw new DiskTransferError(
        "validation",
        "capability_unavailable",
      );
    }
    const candidate = path.resolve(root, localPath);
    if (!isInsideRoot(root, candidate)) {
      throw new DiskTransferError(
        "validation",
        "invalid_local_path",
      );
    }
    return { root, candidate };
  }

  const matches = roots
    .filter((root) => isInsideRoot(root, localPath))
    .sort((left, right) => right.length - left.length);
  const root = matches[0];
  if (root === undefined) {
    throw new DiskTransferError(
      "validation",
      "invalid_local_path",
    );
  }
  return { root, candidate: localPath };
}

function errorCode(error: unknown): string | undefined {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  )
    ? error.code
    : undefined;
}

function effectiveUserId(): number {
  if (typeof process.geteuid !== "function") {
    throw new DiskTransferError("local_io", "unsafe_local_path");
  }
  const value = process.geteuid();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DiskTransferError("local_io", "unsafe_local_path");
  }
  return value;
}

function isTrustedDirectory(
  stats: DiskFileStats,
  effectiveUid: number,
): boolean {
  return (
    !stats.isSymbolicLink() &&
    stats.isDirectory() &&
    Number.isSafeInteger(stats.mode) &&
    Number.isSafeInteger(stats.uid) &&
    (stats.uid === 0 || stats.uid === effectiveUid) &&
    (stats.mode & 0o022) === 0
  );
}

async function assertTrustedDirectoryChain(
  fileSystem: DiskFileSystem,
  canonicalRoot: string,
  effectiveUid: number,
): Promise<void> {
  const filesystemRoot = path.parse(canonicalRoot).root;
  const relative = path.relative(filesystemRoot, canonicalRoot);
  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = filesystemRoot;
  try {
    if (
      !isTrustedDirectory(
        await fileSystem.lstat(current),
        effectiveUid,
      )
    ) {
      throw new DiskTransferError(
        "local_io",
        "unsafe_local_path",
      );
    }
    for (const segment of segments) {
      current = path.join(current, segment);
      if (
        !isTrustedDirectory(
          await fileSystem.lstat(current),
          effectiveUid,
        )
      ) {
        throw new DiskTransferError(
          "local_io",
          "unsafe_local_path",
        );
      }
    }
  } catch (error) {
    if (error instanceof DiskTransferError) {
      throw error;
    }
    throw new DiskTransferError("local_io", "unsafe_local_path");
  }
}

async function inspectLocalPath(
  fileSystem: DiskFileSystem,
  resolved: ResolvedLocalPath,
  direction: Direction,
  overwrite: boolean,
): Promise<void> {
  const effectiveUid = effectiveUserId();
  const rootStats = await fileSystem.lstat(resolved.root);
  if (!isTrustedDirectory(rootStats, effectiveUid)) {
    throw new DiskTransferError("local_io", "unsafe_local_path");
  }
  const canonicalRoot = await fileSystem.realpath(resolved.root);
  if (path.resolve(resolved.root) !== path.resolve(canonicalRoot)) {
    throw new DiskTransferError("local_io", "unsafe_local_path");
  }
  await assertTrustedDirectoryChain(
    fileSystem,
    canonicalRoot,
    effectiveUid,
  );

  const relative = path.relative(resolved.root, resolved.candidate);
  const segments = relative.split(path.sep);
  let current = resolved.root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) {
      throw new DiskTransferError("local_io", "unsafe_local_path");
    }
    current = path.join(current, segment);
    const final = index === segments.length - 1;
    let stats: DiskFileStats;
    try {
      stats = await fileSystem.lstat(current);
    } catch (error) {
      if (
        direction === "download" &&
        final &&
        errorCode(error) === "ENOENT"
      ) {
        break;
      }
      throw new DiskTransferError("local_io", "unsafe_local_path");
    }
    if (
      stats.isSymbolicLink() ||
      (!final && !stats.isDirectory()) ||
      (final && direction === "upload" && !stats.isFile()) ||
      (final && direction === "download" && stats.isDirectory())
    ) {
      throw new DiskTransferError("local_io", "unsafe_local_path");
    }
    if (!final && !isTrustedDirectory(stats, effectiveUid)) {
      throw new DiskTransferError("local_io", "unsafe_local_path");
    }
    if (final && direction === "download" && !overwrite) {
      throw new DiskTransferError("local_io", "destination_exists");
    }
  }

  const parent = path.dirname(resolved.candidate);
  const canonicalParent = await fileSystem.realpath(parent);
  const canonicalCandidate = path.join(
    canonicalParent,
    path.basename(resolved.candidate),
  );
  if (
    !isInsideRoot(canonicalRoot, canonicalCandidate)
  ) {
    throw new DiskTransferError("local_io", "unsafe_local_path");
  }
}

function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new OperationTimeoutError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function exactLinkBody(
  value: unknown,
  expectedMethod: "GET" | "PUT",
): string {
  if (!isPlainDataRecord(value)) {
    throw new DiskTransferError(
      "unknown_upstream",
      "invalid_transfer_link",
    );
  }
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) => key !== "href" && key !== "method" && key !== "templated",
    ) ||
    typeof value.href !== "string" ||
    value.href.length === 0 ||
    value.href.length > 16_384 ||
    (value.method !== undefined &&
      (typeof value.method !== "string" ||
        value.method.toUpperCase() !== expectedMethod)) ||
    (value.templated !== undefined && value.templated !== false)
  ) {
    throw new DiskTransferError(
      "unknown_upstream",
      "invalid_transfer_link",
    );
  }
  return value.href;
}

function allowedTransferHost(
  hostname: string,
  suffixes: readonly string[],
): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === hostname &&
    !normalized.endsWith(".") &&
    suffixes.some(
      (suffix) =>
        normalized === suffix || normalized.endsWith(`.${suffix}`),
    )
  );
}

function validateTransferUrl(
  rawUrl: string,
  suffixes: readonly string[],
): URL {
  if (
    CONTROL_RE.test(rawUrl) ||
    rawUrl.includes("\\") ||
    /%(?![0-9A-Fa-f]{2})/.test(rawUrl) ||
    /%(?:00|0a|0d)/i.test(rawUrl)
  ) {
    throw new DiskTransferError(
      "unknown_upstream",
      "unsafe_transfer_url",
    );
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DiskTransferError(
      "unknown_upstream",
      "unsafe_transfer_url",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.port !== "" && url.port !== "443") ||
    !allowedTransferHost(url.hostname, suffixes)
  ) {
    throw new DiskTransferError(
      "unknown_upstream",
      "unsafe_transfer_url",
    );
  }
  return url;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function redirectLocation(
  response: DirectTransferResponse,
  outcome: FailureOutcome,
): string {
  const location = response.headers.get("location");
  if (
    location === null ||
    location.length === 0 ||
    location.length > 16_384 ||
    CONTROL_RE.test(location)
  ) {
    throw new DiskTransferError(
      "unknown_upstream",
      "unsafe_redirect",
      outcome,
    );
  }
  try {
    new URL(location);
  } catch {
    throw new DiskTransferError(
      "unknown_upstream",
      "unsafe_redirect",
      outcome,
    );
  }
  return location;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^(?:0|[1-9][0-9]{0,2})$/.test(part))
  ) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    return false;
  }
  const first = octets[0] ?? 0;
  const second = octets[1] ?? 0;
  const third = octets[2] ?? 0;
  return !(
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  );
}

function ipv6Words(address: string): readonly number[] | undefined {
  if (isIP(address) !== 6 || address.includes("%")) {
    return undefined;
  }
  let normalized = address.toLowerCase();
  const ipv4Index = normalized.lastIndexOf(":");
  const ipv4Tail = normalized.slice(ipv4Index + 1);
  if (ipv4Tail.includes(".")) {
    if (!isPublicIpv4(ipv4Tail) && isIP(ipv4Tail) !== 4) {
      return undefined;
    }
    const octets = ipv4Tail.split(".").map(Number);
    normalized = `${normalized.slice(0, ipv4Index)}:${(
      ((octets[0] ?? 0) << 8) |
      (octets[1] ?? 0)
    ).toString(16)}:${(
      ((octets[2] ?? 0) << 8) |
      (octets[3] ?? 0)
    ).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) {
    return undefined;
  }
  const left =
    halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const right =
    halves.length === 1 || halves[1] === ""
      ? []
      : (halves[1] ?? "").split(":");
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return undefined;
  }
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((word) => Number.parseInt(word, 16));
  if (
    words.length !== 8 ||
    words.some(
      (word) =>
        !Number.isInteger(word) || word < 0 || word > 0xffff,
    )
  ) {
    return undefined;
  }
  return words;
}

function isPublicIpv6(address: string): boolean {
  const words = ipv6Words(address);
  if (words === undefined) {
    return false;
  }
  const first = words[0] ?? 0;
  const second = words[1] ?? 0;
  const third = words[2] ?? 0;
  if ((first & 0xe000) !== 0x2000) {
    return false;
  }
  return !(
    first === 0x2002 ||
    (first === 0x2001 && second <= 0x01ff) ||
    (first === 0x2001 && second === 0x0db8) ||
    (first === 0x2620 &&
      second === 0x004f &&
      third === 0x8000) ||
    first === 0x3ffe ||
    (first === 0x3fff && second < 0x1000)
  );
}

function isPublicAddress(address: ResolvedAddress): boolean {
  if (address.family === 4) {
    return isPublicIpv4(address.address);
  }
  return isPublicIpv6(address.address);
}

async function resolvePublicAddresses(
  dnsLookup: ResolvedDiskTransferDependencies["dnsLookup"],
  hostname: string,
): Promise<readonly ResolvedAddress[]> {
  let addresses: readonly ResolvedAddress[];
  try {
    addresses = await dnsLookup(hostname);
  } catch {
    throw new DiskTransferError("network", "dns_resolution_failed");
  }
  if (
    addresses.length === 0 ||
    addresses.some((address) => !isPublicAddress(address))
  ) {
    throw new DiskTransferError(
      "unknown_upstream",
      "unsafe_transfer_address",
    );
  }
  return Object.freeze(
    addresses.map((address) => Object.freeze({ ...address })),
  );
}

async function acquireTransferLink(
  config: RuntimeConfig,
  dependencies: ResolvedDiskTransferDependencies,
  params: NormalizedParams,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const endpoint =
    params.direction === "upload"
      ? "v1/disk/resources/upload"
      : "v1/disk/resources/download";
  let result: ToolResult;
  try {
    result = await raceWithAbort(
      dependencies.proxyClient.request({
        providerConfigKey: "yandex-disk",
        operationKind: "read",
        method: "GET",
        path: endpoint,
        query: [
          { name: "path", value: params.remotePath },
          ...(params.direction === "upload"
            ? [
                {
                  name: "overwrite",
                  value: String(params.overwrite),
                },
              ]
            : []),
        ],
        timeoutMs: Math.max(
          1,
          Math.min(timeoutMs, config.transport.maxTimeoutMs),
        ),
      }),
      signal,
    );
  } catch (error) {
    if (error instanceof OperationTimeoutError) {
      throw error;
    }
    throw new DiskTransferError(
      "network",
      "link_acquisition_failed",
    );
  }
  if (!result.ok) {
    throw new DiskTransferError(
      result.error.layer,
      "link_acquisition_failed",
    );
  }
  try {
    return exactLinkBody(
      result.response.body,
      params.direction === "upload" ? "PUT" : "GET",
    );
  } catch (error) {
    if (
      params.direction === "download" &&
      error instanceof DiskTransferError &&
      error.code === "invalid_transfer_link"
    ) {
      throw new DiskTransferError(
        "unknown_upstream",
        "capability_unavailable",
      );
    }
    throw error;
  }
}

function numericSize(stats: DiskFileStats): number {
  const size =
    typeof stats.size === "bigint" ? Number(stats.size) : stats.size;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new DiskTransferError("local_io", "transfer_too_large");
  }
  return size;
}

function sameFileStats(
  before: DiskFileStats,
  after: DiskFileStats,
): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs
  );
}

function uploadBody(
  handle: DiskFileHandle,
  expectedSize: number,
  maxBytes: number,
  signal: AbortSignal,
  progress: {
    bytes: number;
    hash: ReturnType<typeof createHash>;
    complete: boolean;
  },
): AsyncIterable<Uint8Array> {
  return (async function* () {
    const stream = handle.createReadStream({
      autoClose: false,
      start: 0,
    });
    try {
      for await (const rawChunk of stream) {
        if (signal.aborted) {
          throw new OperationTimeoutError();
        }
        const chunk = Uint8Array.from(rawChunk);
        progress.bytes += chunk.byteLength;
        if (
          progress.bytes > maxBytes ||
          progress.bytes > expectedSize
        ) {
          throw new TransferTooLargeError();
        }
        progress.hash.update(chunk);
        yield chunk;
      }
      progress.complete = progress.bytes === expectedSize;
    } finally {
      if (!progress.complete) {
        stream.destroy();
      }
    }
  })();
}

async function disposeResponse(
  response: DirectTransferResponse,
): Promise<void> {
  try {
    await response.cancel();
  } catch {
    // Best-effort cleanup; external error strings are never exposed.
  }
  try {
    await response.close();
  } catch {
    // Best-effort cleanup; external error strings are never exposed.
  }
}

function transferSuccess(
  direction: Direction,
  size: number,
  sha256: string,
  status: number,
): ToolResult {
  return createSuccessResult(RESULT_REQUEST, {
    status,
    contentType: "application/json",
    headers: {},
    body: {
      direction,
      size,
      sha256,
    },
  });
}

async function executeUpload(
  config: RuntimeConfig,
  dependencies: ResolvedDiskTransferDependencies,
  fileSystem: DiskFileSystem,
  params: NormalizedParams,
  resolved: ResolvedLocalPath,
  handle: DiskFileHandle,
  openedStats: DiskFileStats,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ToolResult> {
  const disk = config.disk;
  if (disk === undefined) {
    throw new DiskTransferError(
      "validation",
      "capability_unavailable",
    );
  }
  const size = numericSize(openedStats);
  if (size > disk.maxTransferBytes) {
    throw new DiskTransferError("local_io", "transfer_too_large");
  }
  const pathStats = await fileSystem.lstat(resolved.candidate);
  if (
    pathStats.dev !== openedStats.dev ||
    pathStats.ino !== openedStats.ino ||
    pathStats.isSymbolicLink()
  ) {
    throw new DiskTransferError("local_io", "unsafe_local_path");
  }

  const href = await acquireTransferLink(
    config,
    dependencies,
    params,
    timeoutMs,
    signal,
  );
  let currentHref = href;
  let redirects = 0;
  for (;;) {
    let url: URL;
    try {
      url = validateTransferUrl(
        currentHref,
        disk.transferHostSuffixes,
      );
      await resolvePublicAddresses(
        dependencies.dnsLookup,
        url.hostname,
      );
    } catch (error) {
      if (redirects > 0 && error instanceof DiskTransferError) {
        throw new DiskTransferError(
          error.layer,
          error.code,
          "unknown",
          error.status,
        );
      }
      throw error;
    }

    const progress = {
      bytes: 0,
      hash: createHash("sha256"),
      complete: false,
    };
    const request: DirectTransferRequest = {
      url: url.href,
      method: "PUT",
      headers: {
        "content-length": String(size),
        "content-type": "application/octet-stream",
      },
      body: uploadBody(
        handle,
        size,
        disk.maxTransferBytes,
        signal,
        progress,
      ),
      signal,
    };

    let response: DirectTransferResponse;
    try {
      response = await raceWithAbort(
        dependencies.transferTransport.request(request, {
          lookup: (hostname) =>
            resolvePublicAddresses(
              dependencies.dnsLookup,
              hostname,
            ),
          maxResponseBytes: 65_536,
          timeoutMs,
        }),
        signal,
      );
    } catch (error) {
      throw new DiskTransferError(
        "network",
        error instanceof OperationTimeoutError
          ? "transfer_timeout"
          : error instanceof TransferTooLargeError
            ? "transfer_too_large"
            : "transfer_network_error",
        "unknown",
      );
    }

    try {
      if (REDIRECT_STATUSES.has(response.status)) {
        if (response.status !== 307 && response.status !== 308) {
          throw new DiskTransferError(
            "unknown_upstream",
            "unsafe_redirect",
            "unknown",
            response.status,
          );
        }
        if (redirects >= disk.maxRedirects) {
          throw new DiskTransferError(
            "unknown_upstream",
            "redirect_limit_exceeded",
            "unknown",
            response.status,
          );
        }
        currentHref = redirectLocation(response, "unknown");
        redirects += 1;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new DiskTransferError(
          "unknown_upstream",
          "transfer_http_error",
          response.status >= 400 && response.status < 500
            ? "confirmed_failed"
            : "unknown",
          response.status,
        );
      }
      if (!progress.complete || progress.bytes !== size) {
        throw new DiskTransferError(
          "network",
          "upload_incomplete",
          "unknown",
        );
      }
      const afterStats = await raceWithAbort(handle.stat(), signal);
      if (!sameFileStats(openedStats, afterStats)) {
        throw new DiskTransferError(
          "local_io",
          "source_changed",
          "unknown",
        );
      }
      return transferSuccess(
        "upload",
        size,
        progress.hash.digest("hex"),
        response.status,
      );
    } finally {
      await disposeResponse(response);
    }
  }
}

async function writeAll(
  handle: DiskFileHandle,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(
      chunk,
      offset,
      chunk.byteLength - offset,
      null,
    );
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1) {
      throw new DiskTransferError(
        "local_io",
        "temp_write_failed",
        "confirmed_failed",
      );
    }
    offset += bytesWritten;
  }
}

function contentLength(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  if (value === null) {
    return undefined;
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new DiskTransferError(
      "unknown_upstream",
      "invalid_transfer_response",
      "confirmed_failed",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DiskTransferError(
      "unknown_upstream",
      "invalid_transfer_response",
      "confirmed_failed",
    );
  }
  return parsed;
}

async function destinationIsSymlink(
  fileSystem: DiskFileSystem,
  destination: string,
): Promise<boolean> {
  try {
    return (await fileSystem.lstat(destination)).isSymbolicLink();
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw new DiskTransferError(
      "local_io",
      "unsafe_local_path",
      "confirmed_failed",
    );
  }
}

async function executeDownload(
  config: RuntimeConfig,
  dependencies: ResolvedDiskTransferDependencies,
  fileSystem: DiskFileSystem,
  params: NormalizedParams,
  resolved: ResolvedLocalPath,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ToolResult> {
  const disk = config.disk;
  if (disk === undefined) {
    throw new DiskTransferError(
      "validation",
      "capability_unavailable",
    );
  }
  const href = await acquireTransferLink(
    config,
    dependencies,
    params,
    timeoutMs,
    signal,
  );
  let currentHref = href;
  let redirects = 0;
  let response: DirectTransferResponse | undefined;
  for (;;) {
    let url: URL;
    try {
      url = validateTransferUrl(
        currentHref,
        disk.transferHostSuffixes,
      );
      await resolvePublicAddresses(
        dependencies.dnsLookup,
        url.hostname,
      );
    } catch (error) {
      if (redirects > 0 && error instanceof DiskTransferError) {
        throw new DiskTransferError(
          error.layer,
          error.code,
          "confirmed_failed",
          error.status,
        );
      }
      throw error;
    }

    let candidate: DirectTransferResponse;
    try {
      candidate = await raceWithAbort(
        dependencies.transferTransport.request(
          {
            url: url.href,
            method: "GET",
            headers: {},
            signal,
          },
          {
            lookup: (hostname) =>
              resolvePublicAddresses(
                dependencies.dnsLookup,
                hostname,
              ),
            maxResponseBytes: Math.min(
              Number.MAX_SAFE_INTEGER,
              disk.maxTransferBytes + 1,
            ),
            timeoutMs,
          },
        ),
        signal,
      );
    } catch (error) {
      throw new DiskTransferError(
        "network",
        error instanceof OperationTimeoutError
          ? "transfer_timeout"
          : "transfer_network_error",
        "confirmed_failed",
      );
    }
    if (!REDIRECT_STATUSES.has(candidate.status)) {
      response = candidate;
      break;
    }
    try {
      if (redirects >= disk.maxRedirects) {
        throw new DiskTransferError(
          "unknown_upstream",
          "redirect_limit_exceeded",
          "confirmed_failed",
          candidate.status,
        );
      }
      currentHref = redirectLocation(
        candidate,
        "confirmed_failed",
      );
      redirects += 1;
    } finally {
      await disposeResponse(candidate);
    }
  }
  if (response === undefined) {
    throw new DiskTransferError(
      "unknown_upstream",
      "transfer_network_error",
      "confirmed_failed",
    );
  }

  const randomBytes = dependencies.randomBytes ?? cryptoRandomBytes;
  let tempPath: string | undefined;
  let handle: DiskFileHandle | undefined;
  try {
    if (response.status !== 200) {
      throw new DiskTransferError(
        "unknown_upstream",
        "transfer_http_error",
        "confirmed_failed",
        response.status,
      );
    }
    const declaredLength = contentLength(response.headers);
    if (
      declaredLength !== undefined &&
      declaredLength > disk.maxTransferBytes
    ) {
      throw new DiskTransferError(
        "unknown_upstream",
        "transfer_too_large",
        "confirmed_failed",
      );
    }

    try {
      await raceWithAbort(
        inspectLocalPath(
          fileSystem,
          resolved,
          "download",
          params.overwrite,
        ),
        signal,
      );
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        throw new DiskTransferError(
          "network",
          "transfer_timeout",
          "confirmed_failed",
        );
      }
      if (error instanceof DiskTransferError) {
        throw new DiskTransferError(
          error.layer,
          error.code,
          "confirmed_failed",
          error.status,
        );
      }
      throw new DiskTransferError(
        "local_io",
        "unsafe_local_path",
        "confirmed_failed",
      );
    }

    const nonceBytes = Uint8Array.from(randomBytes(16));
    if (nonceBytes.byteLength !== 16) {
      throw new DiskTransferError(
        "local_io",
        "temp_create_failed",
        "confirmed_failed",
      );
    }
    tempPath = path.join(
      path.dirname(resolved.candidate),
      `.nango-download-${Buffer.from(nonceBytes).toString("hex")}.tmp`,
    );
    try {
      handle = await raceWithAbort(
        fileSystem.open(
          tempPath,
          fsConstants.O_WRONLY |
            fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_NOFOLLOW,
          0o600,
        ),
        signal,
      );
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        throw new DiskTransferError(
          "network",
          "transfer_timeout",
          "confirmed_failed",
        );
      }
      throw new DiskTransferError(
        "local_io",
        "temp_create_failed",
        "confirmed_failed",
      );
    }

    let size = 0;
    const hash = createHash("sha256");
    const iterator = response.body[Symbol.asyncIterator]();
    let iteratorComplete = false;
    try {
      for (;;) {
        const item = await raceWithAbort(
          Promise.resolve(iterator.next()),
          signal,
        );
        if (item.done) {
          iteratorComplete = true;
          break;
        }
        const chunk = Uint8Array.from(item.value);
        const observed = Math.min(
          chunk.byteLength,
          disk.maxTransferBytes + 1 - size,
        );
        size += observed;
        if (size > disk.maxTransferBytes) {
          throw new TransferTooLargeError();
        }
        await raceWithAbort(writeAll(handle, chunk), signal);
        hash.update(chunk);
      }
    } catch (error) {
      if (error instanceof TransferTooLargeError) {
        throw new DiskTransferError(
          "unknown_upstream",
          "transfer_too_large",
          "confirmed_failed",
        );
      }
      if (error instanceof OperationTimeoutError) {
        throw new DiskTransferError(
          "network",
          "transfer_timeout",
          "confirmed_failed",
        );
      }
      if (error instanceof DiskTransferError) {
        throw error;
      }
      throw new DiskTransferError(
        "network",
        "transfer_stream_error",
        "confirmed_failed",
      );
    } finally {
      if (!iteratorComplete && iterator.return !== undefined) {
        void Promise.resolve(iterator.return()).catch(() => undefined);
      }
    }
    if (declaredLength !== undefined && declaredLength !== size) {
      throw new DiskTransferError(
        "network",
        "transfer_stream_error",
        "confirmed_failed",
      );
    }
    try {
      await raceWithAbort(handle.sync(), signal);
      await raceWithAbort(handle.close(), signal);
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        throw new DiskTransferError(
          "network",
          "transfer_timeout",
          "confirmed_failed",
        );
      }
      throw new DiskTransferError(
        "local_io",
        "temp_write_failed",
        "confirmed_failed",
      );
    }
    handle = undefined;
    if (signal.aborted) {
      throw new DiskTransferError(
        "network",
        "transfer_timeout",
        "confirmed_failed",
      );
    }

    try {
      await raceWithAbort(
        inspectLocalPath(
          fileSystem,
          resolved,
          "download",
          params.overwrite,
        ),
        signal,
      );
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        throw new DiskTransferError(
          "network",
          "transfer_timeout",
          "confirmed_failed",
        );
      }
      if (error instanceof DiskTransferError) {
        throw new DiskTransferError(
          error.layer,
          error.code,
          "confirmed_failed",
          error.status,
        );
      }
      throw new DiskTransferError(
        "local_io",
        "unsafe_local_path",
        "confirmed_failed",
      );
    }

    if (params.overwrite) {
      if (
        await destinationIsSymlink(
          fileSystem,
          resolved.candidate,
        )
      ) {
        throw new DiskTransferError(
          "local_io",
          "unsafe_local_path",
          "confirmed_failed",
        );
      }
      try {
        await raceWithAbort(
          fileSystem.rename(tempPath, resolved.candidate),
          signal,
        );
      } catch {
        throw new DiskTransferError(
          "local_io",
          "publish_failed",
          "unknown",
        );
      }
      tempPath = undefined;
    } else {
      try {
        await raceWithAbort(
          fileSystem.link(tempPath, resolved.candidate),
          signal,
        );
      } catch (error) {
        if (errorCode(error) === "EEXIST") {
          throw new DiskTransferError(
            "local_io",
            "destination_exists",
            "confirmed_failed",
          );
        }
        throw new DiskTransferError(
          "local_io",
          "publish_failed",
          "unknown",
        );
      }
      try {
        await fileSystem.unlink(tempPath);
        tempPath = undefined;
      } catch {
        // The destination was atomically published; cleanup is retried below.
      }
    }

    return transferSuccess(
      "download",
      size,
      hash.digest("hex"),
      response.status,
    );
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // Best-effort cleanup; the structured primary failure is retained.
      }
    }
    if (tempPath !== undefined) {
      try {
        await fileSystem.unlink(tempPath);
      } catch {
        // Best-effort cleanup; the structured primary failure is retained.
      }
    }
    await disposeResponse(response);
  }
}

function safeFailure(error: DiskTransferError): FailureResult {
  const messages: Record<string, string> = {
    invalid_disk_transfer: "Disk transfer parameters are invalid",
    invalid_local_path: "Local path is outside an allowed root",
    ambiguous_local_path: "Relative local path is ambiguous",
    unsafe_local_path: "Local path failed safety validation",
    destination_exists: "Download destination already exists",
    approval_required: "Exact one-time approval is required",
    capability_unavailable: "Disk transfer capability is unavailable",
    transfer_too_large: "Disk transfer exceeds the configured limit",
    invalid_transfer_link: "Transfer link response is invalid",
    invalid_transfer_response: "Transfer response metadata is invalid",
    unsafe_transfer_url: "Transfer URL failed safety validation",
    unsafe_transfer_address: "Transfer host failed network validation",
    dns_resolution_failed: "Transfer host resolution failed",
    link_acquisition_failed: "Transfer link acquisition failed",
    unsafe_redirect: "Transfer redirect failed safety validation",
    redirect_limit_exceeded: "Transfer redirect limit was exceeded",
    transfer_network_error: "Direct transfer network request failed",
    transfer_stream_error: "Direct transfer stream failed",
    transfer_timeout: "Direct transfer timed out",
    transfer_http_error: "Direct transfer returned an error",
    upload_incomplete: "Upload body was not completely transferred",
    source_changed: "Upload source changed during transfer",
    source_close_failed: "Upload source could not be safely closed",
    temp_create_failed: "Download temporary file could not be created",
    temp_write_failed: "Download temporary file could not be written",
    publish_failed: "Downloaded file publication was inconclusive",
  };
  return createFailureResult(RESULT_REQUEST, {
    layer: error.layer,
    code: error.code,
    message: messages[error.code] ?? "Disk transfer failed",
    ...(error.status === undefined ? {} : { status: error.status }),
    retryable: false,
    outcome: error.outcome,
  });
}

function approvalFailure(): FailureResult {
  return safeFailure(
    new DiskTransferError("approval", "approval_required"),
  );
}

export function createDiskTransferExecutor(
  config: RuntimeConfig,
  dependencies: DiskTransferDependencies,
): DiskTransferExecutor {
  const networkDefaults =
    createDefaultDiskTransferNetworkDependencies();
  const effectiveDependencies: ResolvedDiskTransferDependencies =
    Object.freeze({
      ...dependencies,
      transferTransport:
        dependencies.transferTransport ??
        networkDefaults.transferTransport,
      dnsLookup:
        dependencies.dnsLookup ?? networkDefaults.dnsLookup,
    });
  const fileSystem =
    effectiveDependencies.fileSystem ?? DEFAULT_FILE_SYSTEM;

  return Object.freeze({
    async execute(
      toolCallId: string,
      params: unknown,
    ): Promise<ToolResult> {
      if (config.disk === undefined) {
        return safeFailure(
          new DiskTransferError(
            "validation",
            "capability_unavailable",
          ),
        );
      }
      let normalized: NormalizedParams;
      let resolved: ResolvedLocalPath;
      try {
        normalized = normalizeParams(config, params);
        if (
          typeof toolCallId !== "string" ||
          toolCallId.length === 0 ||
          config.disk === undefined
        ) {
          throw new DiskTransferError(
            "validation",
            "invalid_disk_transfer",
          );
        }
        const roots =
          normalized.direction === "upload"
            ? config.disk.uploadRoots
            : config.disk.downloadRoots;
        resolved = resolveLocalPath(roots, normalized.localPath);
      } catch (error) {
        return safeFailure(
          error instanceof DiskTransferError
            ? error
            : new DiskTransferError(
                "validation",
                "invalid_disk_transfer",
              ),
        );
      }

      let authorization: ApprovalResult;
      try {
        authorization =
          effectiveDependencies.approvalVerifier.verifyAndConsume(
          TOOL_NAME,
          toolCallId,
          normalized.raw,
        );
      } catch {
        return approvalFailure();
      }
      if (!authorization.ok || authorization.operationKind !== "mutation") {
        return approvalFailure();
      }

      const disk = config.disk;
      if (disk === undefined) {
        return safeFailure(
          new DiskTransferError(
            "validation",
            "capability_unavailable",
          ),
        );
      }
      const monotonicNow = dependencies.monotonicNow ??
        (() => performance.now());
      const setTimer = dependencies.setTimer ??
        ((callback: () => void, delayMs: number) =>
          setTimeout(callback, delayMs));
      const clearTimer = dependencies.clearTimer ??
        ((handle: unknown) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>));
      const timeoutMs = normalized.timeoutMs ?? disk.timeoutMs;
      const startedAt = monotonicNow();
      const controller = new AbortController();
      const timer = setTimer(() => {
        controller.abort(new OperationTimeoutError());
      }, timeoutMs);
      let uploadHandle: DiskFileHandle | undefined;
      try {
        await raceWithAbort(
          inspectLocalPath(
            fileSystem,
            resolved,
            normalized.direction,
            normalized.overwrite,
          ),
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          monotonicNow() - startedAt >= timeoutMs
        ) {
          throw new OperationTimeoutError();
        }
        if (normalized.direction === "upload") {
          uploadHandle = await raceWithAbort(
            fileSystem.open(
              resolved.candidate,
              fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
            ),
            controller.signal,
          );
          const stats = await raceWithAbort(
            uploadHandle.stat(),
            controller.signal,
          );
          if (!stats.isFile()) {
            throw new DiskTransferError(
              "local_io",
              "unsafe_local_path",
            );
          }
          const result = await executeUpload(
            config,
            effectiveDependencies,
            fileSystem,
            normalized,
            resolved,
            uploadHandle,
            stats,
            Math.max(
              1,
              timeoutMs - Math.max(0, monotonicNow() - startedAt),
            ),
            controller.signal,
          );
          try {
            await uploadHandle.close();
            uploadHandle = undefined;
          } catch {
            return safeFailure(
              new DiskTransferError(
                "local_io",
                "source_close_failed",
                result.ok ? "unknown" : result.outcome,
              ),
            );
          }
          return result;
        }
        return await executeDownload(
          config,
          effectiveDependencies,
          fileSystem,
          normalized,
          resolved,
          Math.max(
            1,
            timeoutMs - Math.max(0, monotonicNow() - startedAt),
          ),
          controller.signal,
        );
      } catch (error) {
        if (uploadHandle !== undefined) {
          try {
            await uploadHandle.close();
          } catch {
            // Best-effort close; the structured primary failure is retained.
          }
        }
        if (error instanceof OperationTimeoutError) {
          return safeFailure(
            new DiskTransferError(
              "network",
              "transfer_timeout",
              "not_started",
            ),
          );
        }
        return safeFailure(
          error instanceof DiskTransferError
            ? error
            : new DiskTransferError("local_io", "unsafe_local_path"),
        );
      } finally {
        clearTimer(timer);
      }

    },
  });
}
