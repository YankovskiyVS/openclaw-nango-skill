# amoCRM

- **Skill id:** `amocrm`
- **Nango provider_config_key:** `amocrm`
- **Family:** `amocrm`
- **Scopes:** account data (coarse OAuth scopes in amoМаркет)
- **Upstream base:** `https://{subdomain}.amocrm.ru`

## Operations

### Account

- **Operation name:** `Account`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `api/v4/account`
- **Request shape:** method and relative path; see the exact typed arguments below.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Return only the confirmed account response.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_proxy_request",
  "arguments": {
    "providerConfigKey": "amocrm",
    "method": "GET",
    "path": "api/v4/account"
  }
}
```

## Notes

amoCRM OAuth scopes are coarse; module skills are separate apps for UX/isolation.
