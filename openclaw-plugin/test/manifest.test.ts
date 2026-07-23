import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { PLUGIN_CONFIG_SCHEMA } from "../src/config.js";

const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOOL_NAMES = [
  "nango_proxy_request",
  "nango_proxy_paginate",
  "nango_action",
  "nango_disk_transfer",
] as const;

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(PLUGIN_ROOT, relativePath), "utf8"),
  ) as Record<string, unknown>;
}

describe("OpenClaw plugin manifest", () => {
  test("declares the nango-tools plugin and all four tools as optional", async () => {
    const manifest = await readJson("openclaw.plugin.json");

    expect(manifest).toMatchObject({
      id: "nango-tools",
      name: "Nango Tools",
      activation: { onStartup: true },
      contracts: { tools: TOOL_NAMES },
      configSchema: PLUGIN_CONFIG_SCHEMA,
    });
    expect(Object.keys(manifest.toolMetadata as object).sort()).toEqual(
      [...TOOL_NAMES].sort(),
    );
    for (const toolName of TOOL_NAMES) {
      expect(
        (manifest.toolMetadata as Record<string, unknown>)[toolName],
      ).toEqual({ optional: true });
    }
  });

  test("uses the source entry for development and built JavaScript at runtime", async () => {
    const packageJson = await readJson("package.json");

    expect(packageJson).toMatchObject({
      name: "openclaw-nango-tools",
      version: "0.1.0",
      private: true,
      type: "module",
      engines: { node: ">=22.19.0" },
      files: ["dist", "openclaw.plugin.json"],
      openclaw: {
        extensions: ["./src/index.ts"],
        runtimeExtensions: ["./dist/index.js"],
        compat: { pluginApi: ">=2026.6.11" },
        install: { minHostVersion: ">=2026.6.11" },
      },
    });

    const openclaw = packageJson.openclaw as Record<string, unknown>;
    expect(openclaw.compat).not.toHaveProperty("minGatewayVersion");
  });

  test("keeps aligned source and runtime entries inside the package", async () => {
    const packageJson = await readJson("package.json");
    const openclaw = packageJson.openclaw as Record<string, unknown>;
    const sourceEntries = openclaw.extensions as string[];
    const runtimeEntries = openclaw.runtimeExtensions as string[];

    expect(sourceEntries).toHaveLength(runtimeEntries.length);
    for (const [index, sourceEntry] of sourceEntries.entries()) {
      const runtimeEntry = runtimeEntries[index];
      expect(runtimeEntry).toBeDefined();
      expect(path.parse(sourceEntry).name).toBe(path.parse(runtimeEntry!).name);

      for (const entry of [sourceEntry, runtimeEntry!]) {
        expect(entry.startsWith("./")).toBe(true);
        expect(path.isAbsolute(entry)).toBe(false);
        const relative = path.relative(
          PLUGIN_ROOT,
          path.resolve(PLUGIN_ROOT, entry),
        );
        expect(relative).not.toMatch(/^\.\.(?:[/\\]|$)/);
        expect(path.isAbsolute(relative)).toBe(false);
      }
    }
  });
});
