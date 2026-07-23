# Yandex Delivery Partner

- **Skill id:** `yandex-delivery`
- **Nango provider_config_key:** `yandex-delivery`
- **Family:** `yandex`
- **Scopes:** delivery:partner-api
- **Upstream base:** `https://b2b.taxi.yandex.net`

## Operations

### Legacy create shape — do not execute without real required fields

- **Operation name:** `Legacy create shape — do not execute without real required fields`
- **Availability:** `blocked_contract`
- **Method:** `POST`
- **Path:** `api/b2b/platform/offers/create`
- **Request shape:** Unavailable — exact body fields and a readback/reconciliation contract are not verified.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `unsupported` — no executable operation is classified.
- **Verification:** Do not execute until the exact product body schema, created-entity read path, and unknown-outcome reconciliation route are verified.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Non-executable boundary

No executable typed tool call or catalog fallback command is available. Keep the packaged generic HTTP client for operator-supplied documented paths, but do not invent this missing product contract.

## Notes

The create route requires the exact matching Delivery product schema. Never send an empty create body as a connectivity test.
