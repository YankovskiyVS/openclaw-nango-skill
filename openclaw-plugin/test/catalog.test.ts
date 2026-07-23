import { describe, expect, test } from "vitest";

import {
  CATALOG_PROVIDER_KEYS,
  PROVIDER_KEYS,
  getProviderCatalogEntry,
  isProviderKey,
  resolveProviderKey,
  validateProviderKey,
} from "../src/catalog.js";

const EXPECTED_PROVIDER_KEYS = [
  "yandex-id",
  "yandex-disk",
  "yandex-mail",
  "yandex-calendar",
  "yandex-direct",
  "yandex-maps",
  "yandex-market",
  "yandex-delivery",
  "bitrix24",
  "bitrix24-crm",
  "bitrix24-tasks",
  "bitrix24-disk",
  "bitrix24-im",
  "bitrix24-user",
  "bitrix24-calendar",
  "bitrix24-bizproc",
  "bitrix24-telephony",
  "amocrm",
  "amocrm-crm",
  "amocrm-catalog",
  "amocrm-chats",
  "amocrm-telephony",
  "amocrm-tasks",
  "amocrm-events",
  "amocrm-users",
] as const;

describe("provider catalog", () => {
  test("contains exactly the 25 shipped provider keys plus only yandex alias", () => {
    expect(CATALOG_PROVIDER_KEYS).toEqual(EXPECTED_PROVIDER_KEYS);
    expect(new Set(CATALOG_PROVIDER_KEYS).size).toBe(25);
    expect(PROVIDER_KEYS).toEqual([...EXPECTED_PROVIDER_KEYS, "yandex"]);
    expect(Object.isFrozen(CATALOG_PROVIDER_KEYS)).toBe(true);
    expect(Object.isFrozen(PROVIDER_KEYS)).toBe(true);

    for (const key of PROVIDER_KEYS) {
      expect(isProviderKey(key)).toBe(true);
    }
    for (const invalid of [
      "",
      "Yandex",
      "yandex-crm",
      "amocrm/base",
      "bitrix",
      "unknown",
    ]) {
      expect(isProviderKey(invalid)).toBe(false);
    }
  });

  test("resolves only the intentional legacy alias", () => {
    expect(resolveProviderKey("yandex")).toBe("yandex-id");
    expect(resolveProviderKey("yandex-id")).toBe("yandex-id");
    expect(validateProviderKey("yandex")).toBe("yandex");
    expect(() => resolveProviderKey("unknown")).toThrowError("invalid_provider");
    expect(() => validateProviderKey("unknown")).toThrowError("invalid_provider");
  });

  test("uses code-owned static origins only for confirmed Yandex HTTP APIs", () => {
    expect(getProviderCatalogEntry("yandex-id").staticLinkOrigins).toEqual([
      "https://login.yandex.ru",
    ]);
    expect(getProviderCatalogEntry("yandex-disk").staticLinkOrigins).toEqual([
      "https://cloud-api.yandex.net",
    ]);
    expect(getProviderCatalogEntry("yandex-calendar").staticLinkOrigins).toEqual([
      "https://caldav.yandex.ru",
    ]);
    expect(getProviderCatalogEntry("yandex-direct").staticLinkOrigins).toEqual([
      "https://api.direct.yandex.com",
    ]);
    expect(getProviderCatalogEntry("yandex-market").staticLinkOrigins).toEqual([
      "https://api.partner.market.yandex.ru",
    ]);
    expect(getProviderCatalogEntry("yandex-delivery").staticLinkOrigins).toEqual([
      "https://b2b.taxi.yandex.net",
    ]);

    expect(getProviderCatalogEntry("yandex-maps").staticLinkOrigins).toEqual([]);
    expect(getProviderCatalogEntry("amocrm").staticLinkOrigins).toEqual([]);
    expect(getProviderCatalogEntry("bitrix24").staticLinkOrigins).toEqual([]);
    expect(getProviderCatalogEntry("yandex").key).toBe("yandex-id");
    expect(Object.isFrozen(getProviderCatalogEntry("yandex-id"))).toBe(true);
  });
});
