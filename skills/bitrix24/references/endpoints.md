# Bitrix24

- **Skill id:** `bitrix24`
- **Nango provider_config_key:** `bitrix24`
- **Family:** `bitrix24`
- **Scopes:** user
- **Upstream base:** `https://{domain}/rest`

## Operations

### Current user

- **Operation name:** `Current user`
- **Availability:** `ready`
- **Method:** `GET`
- **Path:** `user.current`
- **Request shape:** method and relative path; see the exact typed arguments below.
- **Pagination:** None — one bounded tool call.
- **Mutability:** `read` — no mutation approval.
- **Verification:** Return only the confirmed current-user response.
- **Authoritative docs:** `not_verified` — no authoritative documentation URL is recorded for this operation.

#### Typed tool call

```json
{
  "tool": "nango_proxy_request",
  "arguments": {
    "providerConfigKey": "bitrix24",
    "method": "GET",
    "path": "user.current"
  }
}
```

## Notes

Connect requires Bitrix24 portal domain. Install module-specific skills when those integrations are connected.
