export const CATALOG_PROVIDER_KEYS = Object.freeze([
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
] as const);

export const PROVIDER_ALIASES = Object.freeze({
  yandex: "yandex-id",
} as const);

export const PROVIDER_KEYS = Object.freeze([
  ...CATALOG_PROVIDER_KEYS,
  "yandex",
] as const);

export type CatalogProviderKey = (typeof CATALOG_PROVIDER_KEYS)[number];
export type ProviderAlias = keyof typeof PROVIDER_ALIASES;
export type ProviderKey = CatalogProviderKey | ProviderAlias;
export type ProviderFamily = "yandex" | "bitrix24" | "amocrm";

export type ProviderCatalogEntry = Readonly<{
  key: CatalogProviderKey;
  family: ProviderFamily;
  staticLinkOrigins: readonly string[];
}>;

const STATIC_LINK_ORIGINS: Readonly<
  Partial<Record<CatalogProviderKey, readonly string[]>>
> = Object.freeze({
  "yandex-id": Object.freeze(["https://login.yandex.ru"]),
  "yandex-disk": Object.freeze(["https://cloud-api.yandex.net"]),
  "yandex-mail": Object.freeze(["https://login.yandex.ru"]),
  "yandex-calendar": Object.freeze(["https://caldav.yandex.ru"]),
  "yandex-direct": Object.freeze(["https://api.direct.yandex.com"]),
  "yandex-market": Object.freeze(["https://api.partner.market.yandex.ru"]),
  "yandex-delivery": Object.freeze(["https://b2b.taxi.yandex.net"]),
});

const EMPTY_ORIGINS: readonly string[] = Object.freeze([]);
const CATALOG_PROVIDER_KEY_SET = new Set<string>(CATALOG_PROVIDER_KEYS);
const PROVIDER_KEY_SET = new Set<string>(PROVIDER_KEYS);

function familyFor(key: CatalogProviderKey): ProviderFamily {
  if (key.startsWith("yandex-")) {
    return "yandex";
  }
  if (key === "bitrix24" || key.startsWith("bitrix24-")) {
    return "bitrix24";
  }
  return "amocrm";
}

export const PROVIDER_CATALOG: Readonly<
  Record<CatalogProviderKey, ProviderCatalogEntry>
> = Object.freeze(
  Object.fromEntries(
    CATALOG_PROVIDER_KEYS.map((key) => [
      key,
      Object.freeze({
        key,
        family: familyFor(key),
        staticLinkOrigins: STATIC_LINK_ORIGINS[key] ?? EMPTY_ORIGINS,
      }),
    ]),
  ) as Record<CatalogProviderKey, ProviderCatalogEntry>,
);

export function isCatalogProviderKey(
  value: unknown,
): value is CatalogProviderKey {
  return typeof value === "string" && CATALOG_PROVIDER_KEY_SET.has(value);
}

export function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === "string" && PROVIDER_KEY_SET.has(value);
}

export function validateProviderKey(value: unknown): ProviderKey {
  if (!isProviderKey(value)) {
    throw new Error("invalid_provider");
  }
  return value;
}

export function resolveProviderKey(value: unknown): CatalogProviderKey {
  const providerKey = validateProviderKey(value);
  return providerKey === "yandex" ? PROVIDER_ALIASES.yandex : providerKey;
}

export function getProviderCatalogEntry(
  value: unknown,
): ProviderCatalogEntry {
  return PROVIDER_CATALOG[resolveProviderKey(value)];
}
