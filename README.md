# OpenClaw Nango skills and typed tools

This repository contains 25 granular OpenClaw skills for Yandex, Bitrix24 and
amoCRM integrations, plus a typed OpenClaw plugin that executes their Nango
operations through explicit security boundaries.

One skill still maps 1:1 to one model-visible Nango
`provider_config_key`. Install only the skills that match OAuth integrations
connected for the user; see [CATALOG.md](CATALOG.md).

## What changed

The original generic HTTP capability is preserved, including GET, POST, PUT,
PATCH, DELETE, HEAD, OPTIONS, CalDAV methods and provider-specific RPC shapes.
The normal agent path is now four typed tools:

| Tool | Purpose |
| --- | --- |
| `nango_proxy_request` | One validated provider request |
| `nango_proxy_paginate` | Bounded registered read pagination |
| `nango_action` | A registered Nango Action with a fixed integration mapping |
| `nango_disk_transfer` | Bounded Yandex Disk upload/download without exposing transfer URLs |

Every skill is plugin-first. Its bundled Python client remains available as an
operator-only compatibility fallback, so existing generic provider operations
were not removed.

The repository also includes:

- Yandex Mail Nango Actions and a bounded IMAP/SMTP HTTPS bridge;
- an amoCRM Chats channel-HMAC send Action;
- generated provider-specific skill instructions and references;
- offline regression suites and CI.

## Why the plugin exists

Prompt instructions alone cannot enforce a safety boundary. The plugin:

- derives project, EvoClaw and Nango connection ids from operator config;
- accepts only catalog provider ids and relative validated paths;
- blocks credential, routing and method-override headers;
- bounds request, response, pagination, Action and transfer sizes;
- separates read retries from mutations;
- returns `not_started`, `confirmed_failed` or `unknown` for failures;
- asks for an exact one-time approval before mutations;
- consumes a proof bound to the exact tool call and parameters before I/O;
- never accepts OAuth tokens or Nango secrets as tool parameters.

Read operations do not prompt. Mutations offer only `allow-once` or `deny`.
Plugin approvals are separate from host exec approvals.

## Repository layout

```text
openclaw-plugin/       typed tools, approval policy and transports
nango-integrations/    Yandex Mail and amoCRM Chats Actions
mail-bridge/           bounded Yandex IMAP/SMTP HTTPS bridge
skills/                25 generated installable skills
catalog/skills.json    skill/catalog source of truth
_shared/               Python fallback and shared API reference
scripts/               generators and validators
tests/                 Python and skill regression tests
docs/                  install, deploy and live-verification runbooks
```

## Install

Build and test the plugin:

```bash
npm ci
npm test --workspace openclaw-plugin
npm run typecheck --workspace openclaw-plugin
npm run build --workspace openclaw-plugin
```

Then follow [docs/install-openclaw-plugin.md](docs/install-openclaw-plugin.md)
for:

- local or managed plugin installation;
- `plugins.entries.nango-tools.config`;
- OpenClaw SecretRefs;
- optional tool exposure;
- plugin approval routing;
- Action proxy/direct modes;
- Yandex Disk roots.

Copy only the required directories from `skills/` into the target agent's
skills workspace.

## Operator configuration

The plugin requires:

- exact Cloud.ru proxy base URL;
- project id;
- EvoClaw id;
- Cloud.ru API key, preferably supplied as an OpenClaw SecretRef.

The provider proxy route is:

```text
{proxyBaseUrl}/api/v1/{projectId}/evo-claws/{evoClawId}/proxy/{providerConfigKey}/{path}
```

The Nango connection id is derived as:

```text
project-{projectId}-evoclaw-{evoClawId}
```

Nango Actions and Disk transfer are independently disabled until their config
blocks are present. The ordinary provider proxy is not assumed to implement
the separate Action backend contract.

## Generate and validate skills

Edit `catalog/skills.json` or the generator, then run:

```bash
python3 scripts/generate_skills.py
python3 scripts/generate_skills.py --check
python3 scripts/validate_skills.py
```

Generated skill packages contain:

```text
skills/<provider>/
  SKILL.md
  references/endpoints.md
  references/api-reference.md
  scripts/nango_proxy.py
```

Do not hand-edit generated copies without updating their source.

## Full offline verification

```bash
python3 -m pip install --requirement requirements-dev.txt
python3 -m pytest -q
python3 scripts/generate_skills.py --check
python3 scripts/validate_skills.py

npm ci
npm test --workspace openclaw-plugin
npm run typecheck --workspace openclaw-plugin
npm run build --workspace openclaw-plugin

(cd nango-integrations && npm ci && npm test && npm run typecheck && npm run build)
(cd mail-bridge && npm ci && npm test && npm run typecheck && npm run build)

git diff --check
```

CI repeats these checks on Python 3.10/3.12 and Node.js 22.22.2 and builds the
mail bridge container.

## Deploy and verify

- [Deploy Nango Actions and the mail bridge](docs/deploy-nango-actions.md)
- [Run live verification](docs/live-verification.md)

Live credentials, provider mutations, `nango dryrun` and deployments are not
part of the offline test suite. A green build therefore does not prove that a
specific OAuth connection or deployed backend works.

Known boundaries:

- Yandex Maps personal bookmarks has no confirmed public API route in this
  repository; generic customer-specific Nango HTTP access remains available.
- Yandex Mail requires the separately deployed HTTPS bridge.
- amoCRM OAuth Talks reads and Chats channel sends use separate internal
  integrations.
- inbound amoCRM Chats webhook verification is not implemented.
- any mutation result with outcome `unknown` must be reconciled at the provider
  before retrying.
