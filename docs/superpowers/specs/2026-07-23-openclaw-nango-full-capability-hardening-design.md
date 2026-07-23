# OpenClaw Nango full-capability hardening

Date: 2026-07-23  
Branch: `feat/production-hardening`  
Upstream baseline: `12903d917509fab4a4da4d7dd0489a42c00286e6`

## Goal

Make all 25 existing skills valid, reproducible and usable by an OpenClaw
agent without removing the generic provider access they already advertise.
Read and write workflows remain available. Mutating calls gain an exact
per-call approval gate, reliable outcome semantics and post-write verification
guidance.

The implementation must not expose OAuth tokens, Nango environment keys or the
Cloud.ru API key to the model, tool result, process arguments or logs.

## Non-goals

- Creating or revoking OAuth connections.
- Deploying Nango functions or changing the Cloud.ru proxy from this repository.
- Claiming live provider compatibility without provider credentials and a
  deployed Nango environment.
- Turning the 25 skills into hard authorization boundaries. Their purpose is
  routing and provider guidance; enforcement belongs to the companion plugin.
- Removing arbitrary provider endpoints. The generic HTTP tool remains
  available for provider operations not yet covered by a higher-level recipe.

## Package shape

The repository ships three coordinated layers:

1. `openclaw-plugin/` — a TypeScript ESM mixed OpenClaw plugin.
2. `skills/` — the existing 25 generated Agent Skills, rewritten to call the
   plugin tools and to describe provider-specific workflows.
3. `nango-integrations/` — optional Nango Action Functions for protocols and
   authentication schemes that cannot be expressed by the HTTP proxy.

The existing Python client stays as a diagnostic and compatibility interface.
It is hardened and tested, but skills no longer make shell execution their
primary runtime path.

## Runtime tools

The plugin registers four typed tools.

### `nango_proxy_request`

Calls an arbitrary relative provider path through the existing Cloud.ru proxy.

Inputs:

- `providerConfigKey`: one of the 25 catalog keys or the explicit legacy alias
  `yandex`.
- `method`: `GET`, `HEAD`, `OPTIONS`, `POST`, `PUT`, `PATCH`, `DELETE`,
  `PROPFIND` or `REPORT`.
- `path`: relative provider path.
- `query`: ordered key/value pairs. Repeated names are allowed.
- `headers`: provider headers. Credential, routing and hop-by-hop headers are
  rejected.
- exactly one of `jsonBody`, `textBody` or `base64Body`.
- `contentType`, when a non-JSON body is used.
- `timeoutMs`, bounded by plugin configuration.

This generic surface preserves all existing HTTP functionality, including
Bitrix24 method-style endpoints, amoCRM REST, Yandex Direct JSON RPC and
Yandex Calendar CalDAV.

### `nango_proxy_paginate`

Performs bounded read-only pagination and returns normalized pages plus the
provider responses. Supported modes:

- `link`: follow a same-origin response link such as amoCRM `_links.next.href`;
- `offset`: update an offset or start parameter, including Bitrix24 `next`;
- `body-offset`: update a JSON body offset, including Yandex Direct
  `Page.Offset`;
- `single`: one request, used when a provider operation is not pageable.

The caller supplies `maxPages` and `maxItems`; configured hard caps always win.
Pagination never follows an absolute URL directly. It extracts only the path
and query after verifying that the URL belongs to the configured upstream
provider origin.

### `nango_action`

Triggers a named Nango Action Function for the same catalog provider and
derived connection id. It is used for Yandex Mail IMAP/SMTP and amoCRM Chats
HMAC operations.

The action transport has two explicit modes:

- recommended `proxy`: call a configured Cloud.ru action endpoint with the
  project API key;
- optional `direct`: call Nango `/action/trigger` with a secret available only
  to plugin runtime.

Direct mode is disabled unless the operator configures it. Secrets are read
inside `execute`, never accepted as tool parameters, and never returned.
Action names are restricted to the registry shipped with the plugin.

### `nango_disk_transfer`

Streams a Yandex Disk upload or download without returning a presigned URL to
the model. Local paths are resolved against configured allowed roots. Uploads
and overwriting downloads require approval. Downloads to a new file are also
treated as mutations because they modify the local filesystem.

The tool first obtains a transfer URL through the Nango proxy, validates the
returned HTTPS URL, performs the transfer without forwarding Cloud.ru or Nango
headers, limits redirects and response size, and returns only metadata.

## Approval policy

The plugin registers a `before_tool_call` hook.

- `GET`, `HEAD`, `OPTIONS`, `PROPFIND` and `REPORT` are read operations and do
  not prompt.
- `POST`, `PUT`, `PATCH` and `DELETE` always request approval.
- `nango_action` consults registry metadata; read actions do not prompt and
  mutating actions do.
- every `nango_disk_transfer` call prompts because it writes provider or local
  state.

Approval requests contain an action, provider, bounded target and risk summary
derived from the validated tool parameters. They never use model-authored
approval text and never include secret or full private payload values.

Only `allow-once` and `deny` are offered. The timeout is 120 seconds and
`timeoutBehavior` is `deny`. If no approval route exists, the call fails
closed. Approval applies only to the exact parameters of that tool call.

The severity is:

- `critical` for delete, overwrite and send/publish operations;
- `warning` for other mutations.

## Request boundary

Before network I/O, both the TypeScript plugin and Python compatibility client
enforce:

- catalog provider ids only;
- no absolute provider URL, fragment, user-info, backslash, empty segment
  trick, decoded `.`/`..` segment or encoded slash/backslash;
- URL-encoding of project, EvoClaw, provider, path and query components;
- proxy base URL limited to `http` or `https`, without credentials, query or
  fragment;
- blocked request headers: `authorization`, `proxy-authorization`, `cookie`,
  `set-cookie`, `host`, `connection`, `transfer-encoding`, `content-length`,
  `x-nango-*` and Cloud.ru credential headers;
- CR/LF rejection in every header name and value;
- bounded request bodies, timeouts, redirects and responses.

The proxy request itself does not follow redirects. A redirect is returned as a
structured error because forwarding credential-bearing headers to another
origin is unsafe. The transfer tool follows a small number of redirects only
after dropping all proxy credentials and revalidating HTTPS on every hop.

## Result and error contract

Every tool returns a JSON-compatible envelope:

```json
{
  "ok": true,
  "request": {
    "providerConfigKey": "amocrm-crm",
    "method": "GET",
    "path": "api/v4/leads"
  },
  "response": {
    "status": 200,
    "contentType": "application/json",
    "headers": {},
    "body": {}
  },
  "outcome": "confirmed"
}
```

Only a response-header allowlist is returned: request id, pagination, rate
limit, retry and entity-version headers. `set-cookie`, authorization and
provider credentials are always removed.

Failures contain:

- `layer`: `validation`, `approval`, `cloudru_proxy`, `nango`,
  `provider`, `network` or `local_io`;
- stable `code`;
- safe message;
- HTTP status when one exists;
- `retryable`;
- `outcome`: `not_started`, `confirmed_failed` or `unknown`.

Provider status is not reinterpreted as a Cloud.ru or OAuth error. The layer is
derived from explicit proxy error metadata when available; otherwise it is
reported as `unknown_upstream` rather than inventing a reconnect diagnosis.

Reads may retry bounded transient network errors, `429` and `5xx`, respecting
`Retry-After`. Mutations are never retried by the plugin. If a mutation times
out after dispatch, the result is `outcome: "unknown"` and the skill instructs
the agent to verify state before considering any repeat.

Text responses are UTF-8 decoded with replacement and capped. JSON is parsed
only when the content type is JSON. Binary bodies are represented by size,
content type and a truncated SHA-256 digest, not printed.

## Provider capability preservation

All 25 provider keys remain in the registry:

- Yandex: ID, Disk, Mail, Calendar, Direct, Maps, Market, Delivery.
- Bitrix24: base, CRM, Tasks, Disk, IM, User, Calendar, Bizproc, Telephony.
- amoCRM: base, CRM, Catalog, Chats, Telephony, Tasks, Events, Users.

HTTP-capable skills use the generic request and pagination tools, so no existing
method or path is removed.

Special adapters:

- Yandex Mail actions: resolve mailbox identity, list/search messages, fetch a
  message and send mail with attachments through IMAP/SMTP XOAUTH2.
- amoCRM Chats actions: send and receive chat messages with the required HMAC
  signature and channel credentials stored in the Nango connection.
- Yandex Disk transfer: upload and download streams.

Where no supported public provider API can be confirmed, the skill must say so
and must not invent endpoints. It may retain generic proxy access for a
customer-specific Nango integration, but it cannot claim a tested public
operation.

## Generated skills

The catalog becomes structured data rather than shell snippets embedded in
Python source. Generation remains deterministic.

Every `SKILL.md`:

- uses only Agent Skills/OpenClaw-supported frontmatter;
- identifies the exact plugin tool and provider key;
- separates read, mutation and uncertain-outcome workflows;
- includes correct pagination and post-write verification guidance;
- links to a provider-specific endpoint reference;
- never tells the model to handle OAuth or Nango secrets;
- routes module-specific requests before generic family skills.

Every `references/endpoints.md` includes operation name, method, path, request
shape, pagination, mutability, verification and authoritative documentation.
Examples use tool-call JSON rather than fragile cwd-relative shell commands.

The generator performs a check mode that fails on drift instead of deleting
and recreating directories blindly.

## Nango Action Functions

Action code is source-controlled but never deployed automatically.

- Input and output use Zod schemas.
- Functions are imported from `nango-integrations/index.ts`.
- Mail dependencies are pinned.
- Access tokens are fetched inside the function execution and used only for the
  provider connection.
- No token, password or channel secret is returned or logged.
- Send operations accept an idempotency key and store a short-lived result
  marker in connection metadata when supported.
- Action output is kept below Nango's 2 MB limit; large attachments and message
  bodies are returned as metadata or streamed through a different path.

Unit tests mock provider transports. Live `nango dryrun` and deployment require
environment credentials and remain an explicit operator step.

## Testing

The repository gains deterministic offline tests and CI.

Python:

- URL/path/query/header validation;
- redirect behavior and response redaction;
- binary and oversized response handling;
- structured errors and mutation timeout outcome;
- CLI parsing, including option placement;
- generator validation, clean regeneration and all 25 packages.

TypeScript plugin:

- exact tool schemas and catalog coverage;
- read versus mutation classification;
- approval request content, decisions and fail-closed settings;
- path and header guards;
- no secret leakage;
- no mutation retry;
- pagination bounds and termination;
- disk transfer origin/header isolation;
- mocked proxy and Nango action responses.

Nango actions:

- schema validation;
- XOAUTH2/HMAC construction without secret leakage;
- message parsing and output caps;
- idempotency behavior.

CI runs Python tests, skill validation, TypeScript typecheck/lint/tests, package
build and a clean-generation check. Live provider tests are separate and are
never presented as passing unless credentials were used in that run.

## Compatibility and rollout

- Minimum OpenClaw version: `2026.5.17`.
- Minimum Node version: `22.19`.
- Python compatibility client: Python 3.10+ with `httpx`.
- The plugin is disabled until installed and enabled by the operator.
- Mutating tools are optional in the plugin manifest and require both
  `tools.allow` exposure and per-call approval.
- Existing skill directory names and provider keys do not change.
- Installation docs explain plugin approval routing independently from exec
  approvals.

## Acceptance criteria

1. There are exactly 25 generated skill directories and every package passes
   the repository validator.
2. Running the generator twice leaves the tree byte-for-byte unchanged.
3. All advertised HTTP methods remain callable through the typed plugin.
4. Every mutating call is blocked unless the exact call receives
   `allow-once`.
5. Read calls do not prompt and cannot smuggle a mutation through method,
   action metadata or transfer mode.
6. Secrets do not appear in tool schemas, argv, logs, approval text or results.
7. Pagination cannot escape the configured provider origin and respects hard
   page/item limits.
8. A dispatched mutation timeout returns an unknown outcome and is not retried.
9. Yandex Mail and amoCRM Chats ship callable adapter code and offline tests;
   docs clearly mark live deployment/credential proof as outstanding until it
   is actually performed.
10. `.env`, upstream branches and the user's OpenClaw state are not modified.
