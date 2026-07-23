# Deploy the Nango Actions

The repository contains two kinds of Actions:

- `yandex-mail`: four OAuth-backed Actions that call the fixed HTTPS mail
  bridge;
- `amocrm-chats-channel`: one channel-HMAC send Action using a separate
  internal Nango integration.

The OpenClaw-visible provider remains `amocrm-chats`; its send action maps to
`amocrm-chats-channel` inside the plugin. This preserves OAuth reads from
`/api/v4/talks` while keeping the channel secret out of the model-visible
connection.

No Action was deployed and no live credential was used during repository
hardening. The commands below are an operator runbook, not evidence of a live
deployment.

## Offline verification

```bash
cd nango-integrations
npm ci
npm test
npm run typecheck
npm run build
npm audit
```

The pinned toolchain requires Node.js 22.22.2 or newer.

## Yandex Mail bridge

Build the bridge:

```bash
cd mail-bridge
npm ci
npm test
npm run typecheck
npm run build
docker build -t openclaw-yandex-mail-bridge:reviewed .
```

Deploy it behind an exact HTTPS origin. Configure:

| Variable | Meaning |
| --- | --- |
| `MAIL_BRIDGE_HMAC_SECRET` | Shared random secret, at least 32 bytes |
| `MAIL_BRIDGE_REPLICA_MODE` | Explicitly `single` or `multi` |
| `MAIL_BRIDGE_REDIS_URL` | Required in `multi` mode |
| `MAIL_BRIDGE_PORT` | Optional listener port, default `8080` |
| `MAIL_BRIDGE_BIND_ADDRESS` | Optional bind address, default `0.0.0.0` |

Production replicas should use `multi` with a shared Redis ledger. `single`
uses bounded process memory, so a restart loses replay and idempotency state.

The bridge accepts only signed JSON POSTs on fixed routes. It pins outbound
mail traffic to:

```text
imap.yandex.com:993 TLS
smtp.yandex.com:465 TLS
```

It does not return or log the OAuth access token. Configure these Nango
environment variables for the Yandex Mail integration:

```text
MAIL_BRIDGE_ORIGIN=https://mail-bridge.example
MAIL_BRIDGE_HMAC_SECRET=<same shared secret>
```

The Yandex OAuth connection must include a full mailbox address in
`connection_config.mailbox`. Custom-domain mailboxes are supported. Required
scopes are:

```text
mail:imap_full
mail:smtp
```

The Actions never accept a mailbox, token, bridge URL or connection override
from their input.

## amoCRM Chats channel integration

Create a separate Nango integration named exactly:

```text
amocrm-chats-channel
```

Its connection contains the operator-managed channel secret, `scope_id`,
sender bot identity and the selected region (`ru` or `com`). It is distinct
from the OAuth `amocrm-chats` integration used for Talks reads.

The outbound action signs one exact serialized request body with:

```text
METHOD
lowercase MD5(body bytes)
application/json
RFC2822 Date
PATH
```

The resulting signature is lowercase HMAC-SHA1. Requests are restricted to
the code-selected `amojo.amocrm.ru` or `amojo.amocrm.com` origin and use zero
automatic retries.

Receiving amoCRM channel webhooks is not implemented here. A receiver needs a
separate raw-body HMAC-SHA1 verification boundary; do not route inbound
webhooks to the outbound Action.

## Compile

The local tests above do not need Nango credentials. Nango CLI compilation
does. Supply credentials through the operator environment or a protected
secret provider; do not commit a `.env` file:

```bash
cd nango-integrations
npx nango compile --no-dependency-update --no-telemetry
```

Compilation writes local Nango build metadata. Review its diff before deploy.

## Dry run against explicit connections

Dry runs make live provider calls and require explicit operator credentials
and connection ids:

```bash
npx nango dryrun resolve-mailbox CONNECTION_ID \
  --integration-id yandex-mail \
  --environment dev \
  --validate \
  --no-dependency-update \
  --no-telemetry

npx nango dryrun list-messages CONNECTION_ID \
  --integration-id yandex-mail \
  --environment dev \
  --input '{"folder":"INBOX","limit":1}' \
  --validate \
  --no-dependency-update \
  --no-telemetry
```

Do not dry-run `send-message` until the recipient, body and idempotency key
have been reviewed. A transport failure after SMTP or amoCRM dispatch has
outcome `unknown`; inspect provider state before any retry.

## Deploy

Deploy to development first:

```bash
npx nango deploy dev \
  --no-dependency-update \
  --no-telemetry
```

After the development live checks pass, deploy an explicit integration or
action to production:

```bash
npx nango deploy prod \
  --integration yandex-mail \
  --no-dependency-update \
  --no-telemetry
```

Review destructive-change prompts. Do not add `--allow-destructive` merely to
make CI non-interactive.

After deployment, configure `nango-tools` Action transport as described in
[install-openclaw-plugin.md](install-openclaw-plugin.md) and perform the live
checks in [live-verification.md](live-verification.md).
