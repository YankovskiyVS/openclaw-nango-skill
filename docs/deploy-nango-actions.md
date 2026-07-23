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

From a fresh checkout, verify the Nango package without installing the bridge
first:

```bash
cd nango-integrations
npm ci
npm run test:unit
npm run typecheck
npm run verify:nango
npm run build
npm audit
```

The localhost HTTPS acceptance imports production bridge source, so install
the bridge package before running the cross-package checks:

```bash
cd ../mail-bridge
npm ci
cd ../nango-integrations
npm run test:e2e
npm run typecheck:e2e
```

After both installs, `npm test` in `nango-integrations` runs the unit and E2E
suites together. CI preserves this ordering and runs the E2E suite explicitly.
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

The regular test suite skips the real Redis/Lua integration unless the exact
`MAIL_BRIDGE_TEST_REDIS_URL` variable is present. To run that gate, point it
only at a disposable Redis instance:

```bash
MAIL_BRIDGE_TEST_REDIS_URL=redis://127.0.0.1:6379 npm run test:redis
```

The test creates unique random keys with a 10-second TTL, never calls
`FLUSHDB`, and closes both independent clients. CI supplies a dedicated
health-checked `redis:7.4-alpine` service; do not point this test at a shared or
production Redis.

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
In `multi` mode the bridge emits safe JSON status transitions on stderr with
component `mail_bridge_redis` and code `redis_ready` or
`shared_store_unavailable`; raw Redis errors and the Redis URL are omitted.
While unavailable, replay/idempotency operations fail closed with HTTP 503
before dispatch, and a later Redis `ready` event restores them.

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

The send action uses Nango's shared execution lock plus the dedicated
connection's `openclawAmoSendLedgerV1` metadata field as its result ledger.
Keep that field action-owned. A repeated identical `msgid` returns the cached
confirmation, a different body conflicts before dispatch, and pending or
unknown state never triggers a second provider call. Entries are retained for
30 days in a bounded 256-entry ledger; generate globally unique message ids and
never reuse one after retention or eviction.

Receiving amoCRM channel webhooks is not implemented here. A receiver needs a
separate raw-body HMAC-SHA1 verification boundary; do not route inbound
webhooks to the outbound Action.

## Compile

Compilation is a credential-free checkout gate. It typechecks with Nango's
canonical compiler options, bundles every declared action, and verifies the
expected two integrations, five versioned actions, and five build artifacts:

```bash
cd nango-integrations
npm run verify:nango
```

Compilation writes ignored local artifacts under `.nango/` and `build/`.
It does not make provider calls, deploy actions, or require a Nango account.

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
