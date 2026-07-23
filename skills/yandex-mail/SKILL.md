---
name: yandex-mail
description: "Yandex Mail tasks: read or send Yandex Mail."
metadata: {"openclaw":{},"nango":{"family":"yandex","provider_config_key":"yandex-mail"}}
---

# Yandex Mail

Use this skill when the user requests read or send Yandex Mail through the configured Nango connection.

- Route only to `providerConfigKey`: **`yandex-mail`**.
- Scopes / access: `mail:imap_full, mail:smtp, login:email`
- Upstream base (via Nango): `https://login.yandex.ru (identity); mail via IMAP/SMTP`

## Workflow

1. Use the exact provider key above; never route by a similar vendor name.
2. Use `nango_proxy_request` for one provider request and `nango_proxy_paginate` only for a registered bounded read contract.
3. Use `nango_action` only for a registered action and `nango_disk_transfer` only for Yandex Disk file transfer.
4. Reads run without a prompt. Every semantic mutation requires one-time approval tied to the exact tool call and parameters.
5. Treat `confirmed` as completed, `not_started` as safe to fix and retry, and `confirmed_failed` as a provider-confirmed failure. For `unknown`, inspect provider state and do not retry blindly.
6. Do not infer the failing layer from HTTP status alone. Return the tool's safe error code and outcome; never expose credentials.

Do not use the Python fallback to bypass approval.

## Typed tools

### Mail actions

Use `nango_action` only with these registered actions:

- `resolve-mailbox`
- `list-messages`
- `get-message`
- `send-message`

Example bounded read:

```json
{
  "providerConfigKey": "yandex-mail",
  "actionName": "list-messages",
  "input": {
    "folder": "INBOX",
    "limit": 25
  }
}
```

For `send-message`, pass recipients, body, optional inline base64 attachments, and a stable `idempotencyKey` inside `input`.

The action reaches the fixed Yandex IMAP/SMTP bridge. Do not extract or expose the OAuth token, and do not attempt IMAP or SMTP through `nango_proxy_request`. A confirmed send returns a Message-ID; an `unknown` send must be checked in mailbox state before another key is used.

Request inputs are strict: relative `path`, ordered `query` pairs, bounded headers/body, and no caller-supplied auth, raw Nango control headers, approval proof, or operation classification fields.

## Operator-only fallback

Keep this compatibility path for diagnostics or deployments where the plugin is unavailable. It requires `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`, Python 3, and `httpx`. An operator must explicitly choose it. Mutations still need approval and post-write verification.

```bash
# Resolve mailbox email
python3 {baseDir}/scripts/nango_proxy.py call yandex-mail info --query 'format=json' --json-output
```

The fallback preserves the full generic HTTP flags documented in `{baseDir}/references/api-reference.md`.

## Notes

The Python fallback resolves identity only. Mailbox reads and sends use registered Nango actions backed by the fixed IMAP/SMTP bridge; never expose the OAuth token.

## References

- `{baseDir}/references/endpoints.md` — endpoints for this skill
- `{baseDir}/references/api-reference.md` — proxy contract
