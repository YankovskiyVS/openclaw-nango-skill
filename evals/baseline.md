# Skill evaluation baseline

Upstream baseline:
`12903d917509fab4a4da4d7dd0489a42c00286e6`.

This is an offline evaluation baseline for the 25 upstream skills. `STATIC`
means the finding comes from repository text or source inspection. `REPRO`
means the failure was reproduced locally without credentials or network I/O.
`NOT LIVE TESTED` means no `.env`, provider credential, live provider API,
OpenClaw CLI or Nango deployment was used. These findings are not live
compatibility proof.

The expected future behavior is encoded in `evals/skill-cases.json`. It
preserves every skill/provider key and generic HTTP access while adding cases
for routing, pagination, approvals, uncertain mutation outcomes and the
protocol-specific adapters.

## REPRO: invalid generated commands

The following commands are copied verbatim from the upstream skill bodies.
Both fail during `argparse` JSON conversion, before environment resolution or
network I/O.

Source: `skills/yandex-direct/SKILL.md:64`.

```bash
python3 {baseDir}/scripts/nango_proxy.py call yandex-direct json/v5/campaigns --method POST --json '{{"method":"get","params":{{"SelectionCriteria":{{}},"FieldNames":["Id","Name"]}}}}' --json-output
```

Result after substituting the repository skill directory for `{baseDir}`:
exit 2, `argument --json: invalid loads value`. The generated skill leaked
Python format-string brace escaping into the shell command.

Source: `skills/yandex-delivery/SKILL.md:64`.

```bash
python3 {baseDir}/scripts/nango_proxy.py call yandex-delivery api/b2b/platform/offers/create --method POST --json '{{}}' --json-output
```

Result after substituting the repository skill directory for `{baseDir}`:
exit 2, `argument --json: invalid loads value`. It also presents a state-changing
`offers/create` request as a probe, without approval or post-write verification.

## STATIC: cross-cutting failures

- Unsupported package frontmatter appears in all 25 skill bodies:
  `timeout_sec`, `required_pip` and `required_env`
  (`skills/*/SKILL.md:4-7`). The already-observed validator result rejects
  these top-level keys; the OpenClaw CLI was not rerun for this baseline.
- All 25 endpoint references contain cwd-relative commands such as
  `python3 scripts/nango_proxy.py ...`
  (`skills/*/references/endpoints.md:14`). They do not resolve reliably from an
  arbitrary agent working directory.
- Pagination guidance is absent from all 25 `SKILL.md` files. List examples are
  one-shot calls even for Bitrix24 `next`, amoCRM link pagination, Yandex Disk
  offsets and Yandex Direct body offsets.
- Domain approval, dry-run guidance and post-write verification are absent
  from all 25 skill bodies. Mutating examples can therefore execute without a
  skill-level decision point or a read-after-write check.
- Every skill hardcodes the same diagnosis:
  `401` means API key/IAM, `404` means wrong `EVOCLAW_ID`, and every upstream
  `4xx/5xx` means reconnect OAuth (`skills/*/SKILL.md:73-75`). This collapses
  Cloud.ru proxy, Nango and provider failures into one explanation and can
  prescribe an unrelated reconnect.
- The compatibility CLI accepts `--api-key` and puts the supplied secret in
  process arguments (`_shared/scripts/nango_proxy.py:139-141`), then creates an
  Authorization header from it (`_shared/scripts/nango_proxy.py:65-72`).
- The CLI follows redirects while carrying a credential-bearing request
  (`_shared/scripts/nango_proxy.py:86-90`) and returns all response headers in
  JSON output. The baseline has no redirect-origin or response-redaction
  guarantee.
- A dispatched mutation timeout has no distinct `unknown` outcome. The skills
  do not tell the agent to verify state before considering a repeat.

## STATIC: provider-specific failures and impossible paths

### Yandex Mail

The skill advertises reading and sending mail
(`skills/yandex-mail/SKILL.md:3,44`) but its only executable command resolves
identity over HTTP (`skills/yandex-mail/SKILL.md:63-64`). Its own note says the
HTTP proxy cannot speak IMAP and instructs the caller to use an OAuth token
with XOAUTH2 (`skills/yandex-mail/SKILL.md:78-80`), while the skill also says
OpenClaw never sees that token (`skills/yandex-mail/SKILL.md:40`). There is no
callable IMAP/SMTP adapter path, so list, fetch and send cannot be completed by
the advertised tooling.

### Yandex Calendar

The only example calls `calendars/` with default GET and provides no CalDAV
`PROPFIND`/`REPORT`, `Depth` header, XML request body, ETag handling or
calendar-event verification (`skills/yandex-calendar/SKILL.md:60-80`).
Labeling the integration CalDAV does not make the shown JSON-oriented command
a complete CalDAV workflow.

### Yandex Disk

The skill claims list/upload/download capability
(`skills/yandex-disk/SKILL.md:42-44`) but only documents disk metadata and a
root listing (`skills/yandex-disk/SKILL.md:60-66`). It has no two-step transfer
workflow, safe presigned-URL handling, credential separation, local-path
boundary or streamed upload/download adapter.

### Yandex Direct

Besides the reproduced invalid JSON, the current skill has no JSON-RPC
body-offset pagination and no way to distinguish a read-style POST from a
mutation for approval and retry policy (`skills/yandex-direct/SKILL.md:63-64`).

### Yandex Delivery

The skill combines the Express-style host `https://b2b.taxi.yandex.net`
(`skills/yandex-delivery/SKILL.md:38`) with the other-day delivery path
`api/b2b/platform/offers/create` (`skills/yandex-delivery/SKILL.md:64`).
The contract families are mixed, and the shown mutating probe is also invalid
JSON. This is a static contract defect, not a live provider result.

### Yandex Maps

The skill claims a bookmarks API but says the exact REST paths depend on the
product (`skills/yandex-maps/SKILL.md:44,78-80`) and then invents the generic
path `v1/` (`skills/yandex-maps/SKILL.md:63-64`). No supported public bookmarks
endpoint was confirmed. Generic customer-specific proxy access may remain,
but the baseline must not treat `v1/` as a tested public operation.

### Yandex Market

The skill itself states that Market prefers API-key authentication for new
applications and OAuth works only for transitional setups
(`skills/yandex-market/SKILL.md:78-80`). The OAuth-routed command is therefore
an unverified compatibility claim, not general proof for current applications.

### Bitrix24 CRM

Lead/deal list examples are single calls
(`skills/bitrix24-crm/SKILL.md:63-66`) without Bitrix24 `next/start`
pagination. Mutations have neither per-call approval nor read-after-write or
unknown-outcome guidance.

### amoCRM Chats

The only command reads core REST talks at `api/v4/talks`
(`skills/amocrm-chats/SKILL.md:60-64`). It does not implement the HMAC-signed
Chats send/receive protocol or retrieve channel credentials inside a trusted
adapter. Sending a chat message is therefore not reachable through the
advertised path.

## Boundary of this baseline

`NOT LIVE TESTED`: OAuth connections, Nango actions, provider responses,
OpenClaw loading and approval routing remain unproven here. Later evaluation
must report offline tests separately from credentialed deployment and live
provider smoke tests.
