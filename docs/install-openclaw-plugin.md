# Install the OpenClaw plugin

The skills describe provider workflows. The `nango-tools` plugin is the
runtime boundary that validates calls, keeps credentials out of model-visible
parameters, requests approval for mutations and executes the provider request.

## Build and inspect

Use Node.js 22.22.2 for the repository verification path:

```bash
npm ci
npm test --workspace openclaw-plugin
npm run typecheck --workspace openclaw-plugin
npm run build --workspace openclaw-plugin
```

For a local development checkout, install or link only the plugin directory:

```bash
openclaw plugins install --link ./openclaw-plugin
openclaw plugins inspect nango-tools --runtime --json
```

Use a copied install instead of `--link` when the checkout will not remain on
the Gateway host:

```bash
openclaw plugins install ./openclaw-plugin
```

Plugin installation executes trusted code on the Gateway host. Pin a reviewed
commit for production.

## Configure

Put plugin settings under `plugins.entries.nango-tools.config`. This example
uses SecretRefs so secret values are resolved into OpenClaw's runtime snapshot
instead of being embedded in the plugin config:

```json5
{
  plugins: {
    allow: ["nango-tools"],
    entries: {
      "nango-tools": {
        enabled: true,
        config: {
          cloudru: {
            proxyBaseUrl: "https://PROXY_HOST",
            projectId: "PROJECT_ID",
            evoClawId: "EVOCLAW_ID",
            apiKey: {
              source: "env",
              provider: "default",
              id: "CLOUDRU_API_KEY",
            },
          },
          transport: {
            defaultTimeoutMs: 30000,
            maxTimeoutMs: 300000,
            operationDeadlineMs: 300000,
            readAttempts: 3,
            initialBackoffMs: 250,
            maxBackoffMs: 5000,
            maxRequestBytes: 1048576,
            maxResponseBytes: 1048576,
          },
          pagination: {
            maxPages: 25,
            maxItems: 1000,
          },
        },
      },
    },
  },
  tools: {
    alsoAllow: ["nango-tools"],
  },
}
```

`plugins.allow` authorizes the plugin itself. `tools.alsoAllow` exposes its
four optional tools without replacing the normal tool profile:

- `nango_proxy_request`
- `nango_proxy_paginate`
- `nango_action`
- `nango_disk_transfer`

If the same scope already defines `tools.allow`, add either `nango-tools` or
the four exact tool names to that existing allowlist. Do not set `allow` and
`alsoAllow` in the same scope.

The Cloud.ru provider route remains:

```text
{proxyBaseUrl}/api/v1/{projectId}/evo-claws/{evoClawId}/proxy/{providerConfigKey}/{path}
```

The connection id is derived in code:

```text
project-{projectId}-evoclaw-{evoClawId}
```

The model cannot supply either identifier, an OAuth token or a Nango secret.

## Enable Nango Actions

Actions are disabled when `actions` is omitted. Choose exactly one transport.

Recommended proxy mode calls one operator-configured Cloud.ru endpoint and
uses the existing project API key:

```json5
{
  actions: {
    transport: {
      mode: "proxy",
      endpointUrl: "https://ACTION_PROXY_HOST/exact/action/path",
    },
    syncTimeoutMs: 30000,
    maxInputBytes: 1048576,
    maxOutputBytes: 1048576,
  },
}
```

That endpoint is a separate backend capability. It must implement the exact
request and response contract documented by the plugin. Do not point this
setting at the ordinary provider proxy and assume it supports Actions.

The plugin sends one JSON `POST` with `Authorization: Api-Key <cloudru key>`
and this exact body shape:

```json
{
  "projectId": "<configured project id>",
  "evoClawId": "<configured EvoClaw id>",
  "connectionId": "project-<project id>-evoclaw-<EvoClaw id>",
  "providerConfigKey": "<code-selected internal integration id>",
  "actionName": "<registered action name>",
  "input": {}
}
```

The backend response must be JSON in one of these two shapes:

```json
{"ok":true,"result":{"ok":true,"outcome":"confirmed","result":{}}}
```

```json
{"ok":false,"error":{"layer":"cloudru_proxy","code":"stable_code","message":"Safe bounded message","retryable":false}}
```

The endpoint must not redirect. The plugin bounds and validates the complete
response, promotes an Action business failure to the tool's top-level failure
outcome, and never returns configured secrets or arbitrary response headers.

Direct mode is an explicit operator-controlled fallback:

```json5
{
  actions: {
    transport: {
      mode: "direct",
      baseUrl: "https://api.nango.dev",
      secretKey: {
        source: "env",
        provider: "default",
        id: "NANGO_SECRET_KEY",
      },
    },
  },
}
```

Direct mode calls only `/action/trigger`. The integration id is selected by
the code-owned action registry; the caller cannot substitute it.

## Enable Yandex Disk transfer

Disk transfer is disabled when `disk` is omitted. Configure narrow, existing,
absolute roots. Never use `/`, a home directory or a shared workspace root:

```json5
{
  disk: {
    uploadRoots: ["/srv/openclaw/export"],
    downloadRoots: ["/srv/openclaw/import"],
    maxTransferBytes: 1073741824,
    maxRedirects: 3,
    timeoutMs: 300000,
  },
}
```

Local paths must remain beneath one configured root. The runtime rejects
traversal, symlinks, unsafe transfer hosts and non-public network targets.
Each configured root, its canonical ancestors and every traversed child
directory must be owned by either root or the Gateway OS user and must not be
group- or world-writable. Do not grant another OS identity write access through
an ACL; ownership and mode are enforced by the runtime, while ACL provisioning
remains an operator responsibility. Configure the fully canonical root path:
roots reached through a symlink alias fail closed even when the final
directory is otherwise safe. Provision dedicated POSIX directories such as
the `/srv/openclaw` example; shared writable roots fail closed. Processes
running under the same Gateway OS identity are inside this local trust
boundary and must not be treated as mutually hostile.

## Route approvals

All four tools are optional, but visibility is not the same as per-call
approval. Reads execute without a prompt after validation. Mutations and every
Disk transfer request a plugin approval with only:

- `allow-once`
- `deny`

Configure plugin approval delivery separately from exec approvals:

```json5
{
  approvals: {
    plugin: {
      enabled: true,
      mode: "targets",
      agentFilter: ["main"],
      targets: [{ channel: "slack", to: "OPERATOR_ID" }],
    },
  },
}
```

`approvals.plugin` does not inherit `approvals.exec`. If no approval-capable
surface can resolve a mutation, the call fails closed. A successful approval
is bound to the exact tool-call id and business parameters, is consumed once,
and cannot be replayed for a modified call.

## Install only relevant skills

Copy only provider skills that correspond to completed OAuth connections:

```text
skills/yandex-disk/
skills/bitrix24-crm/
skills/amocrm-crm/
```

The Python client inside each skill is an operator-only compatibility fallback.
The normal agent path is the typed plugin. Python fallback mutations do not
bypass the plugin's approval boundary.

## Restart and verify

After applying config, restart or reload the Gateway and inspect the runtime:

```bash
openclaw plugins list --enabled --verbose
openclaw plugins inspect nango-tools --runtime --json
openclaw config validate --json
```

Then follow [live-verification.md](live-verification.md). Do not infer a live
OAuth or provider result from a successful local build.
