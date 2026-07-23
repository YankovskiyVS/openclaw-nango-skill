# OpenClaw Nango full-capability hardening implementation plan

> Design:
> `docs/superpowers/specs/2026-07-23-openclaw-nango-full-capability-hardening-design.md`

**Goal:** Preserve all 25 provider capabilities while adding valid packaging,
typed OpenClaw tools, exact per-call approvals, reliable transport semantics,
special Nango adapters and repeatable tests.

**Architecture:** A mixed TypeScript OpenClaw plugin owns runtime enforcement.
Generated skills contain concise provider workflows and progressive references.
The Python CLI remains a tested compatibility client. Nango Action Functions
cover special HTTP authentication and orchestrate a narrow HTTPS mail bridge;
the bridge owns Yandex IMAP/SMTP because Nango Functions cannot import TCP/TLS
clients.

**Stack:** Python 3.10+, pytest, httpx; Node 22+, TypeScript ESM, TypeBox,
Vitest; Nango Action Functions with Zod.

## Execution rules

- Follow RED → verify RED → GREEN → verify GREEN → REFACTOR for every behavior.
- Do not run the OpenClaw CLI while implementing; a previous validation attempt
  migrated the user's global approval state despite an isolated state setting.
- Do not access `.env`, provider credentials or live provider APIs.
- Keep unrelated user files and upstream branches untouched.
- Commit each completed task to `feat/production-hardening`.

## Task 1: Record skill evaluation baseline

**Files:**

- Create: `evals/skill-cases.json`
- Create: `evals/baseline.md`
- Create: `tests/test_skill_cases.py`

**RED**

1. Add representative cases for routing, pagination, mutation approval,
   unknown outcomes, Yandex Mail, Calendar, Disk transfer, Direct, Delivery,
   Maps, Market, Bitrix24 CRM and amoCRM Chats.
2. Add a structural test requiring a case for every one of the 25 skills and
   every risk category.
3. Run `python3 -m pytest tests/test_skill_cases.py -q`; verify it fails because
   the case files do not exist.

**GREEN**

1. Encode expected tool, provider key, operation kind, approval behavior and
   verification behavior for every case.
2. Record the already-observed baseline failures from the upstream skills,
   including exact invalid commands and impossible adapter paths.
3. Run the targeted test and verify it passes.

## Task 2: Harden the Python compatibility client

**Files:**

- Create: `tests/test_nango_proxy.py`
- Modify: `_shared/scripts/nango_proxy.py`

**RED / GREEN slices:**

1. Test and implement strict proxy URL, provider, relative path and query
   validation.
2. Test and implement blocked credential/hop-by-hop headers and CR/LF
   rejection.
3. Test and implement mutually exclusive JSON/text/file bodies and bounded
   request size.
4. Test and implement no redirects for credential-bearing proxy requests.
5. Test and implement response header redaction, binary summaries and output
   size caps.
6. Test and implement structured error layers and `unknown` outcome for
   dispatched mutation timeouts.
7. Test and implement CLI options on both the root parser and `call`
   subcommand. Add `--api-key-file` for safe overrides; retain the legacy
   `--api-key` as a hidden, deprecated compatibility option that emits a
   warning so no existing callable behavior is removed.

After every slice run:

```bash
python3 -m pytest tests/test_nango_proxy.py -q
```

Then run the full Python suite.

## Task 3: Make generation safe and deterministic

**Files:**

- Create: `catalog/skills.json`
- Create: `scripts/validate_skills.py`
- Create: `tests/test_generate_skills.py`
- Create: `tests/test_validate_skills.py`
- Modify: `scripts/generate_skills.py`
- Modify: `CATALOG.md`

**RED**

1. Test exactly 25 unique ids/provider keys, supported frontmatter only,
   canonical shared copies, valid embedded JSON and resolvable references.
2. Test `--check` against a deliberately stale temporary tree.
3. Test two generations produce no diff and do not double braces.
4. Verify each test fails against the baseline.

**GREEN**

1. Move provider metadata and operations into deterministic JSON.
2. Render into a temporary directory, compare in `--check`, and replace only
   generated files in normal mode.
3. Generate a catalog and skill packages without unsupported frontmatter.
4. Run:

```bash
python3 scripts/generate_skills.py
python3 scripts/generate_skills.py --check
python3 scripts/validate_skills.py
python3 -m pytest tests/test_generate_skills.py tests/test_validate_skills.py -q
```

## Task 4: Scaffold the OpenClaw plugin package

**Files:**

- Create: `package.json`
- Create: `package-lock.json`
- Create: `openclaw-plugin/package.json`
- Create: `openclaw-plugin/tsconfig.json`
- Create: `openclaw-plugin/vitest.config.ts`
- Create: `openclaw-plugin/openclaw.plugin.json`
- Create: `openclaw-plugin/src/index.ts`
- Create: `openclaw-plugin/test/manifest.test.ts`
- Create: `openclaw-plugin/test/runtime-scaffold.test.ts`

**RED**

1. Test manifest id, four declared optional tools, activation and strict config
   schema.
2. Test `extensions` points to source, `runtimeExtensions` points to built
   JavaScript, `compat.pluginApi` and the enforced
   `install.minHostVersion`/Node floors target OpenClaw `2026.6.11`.
3. Test the source/runtime entry arrays align and never escape the package.
4. Test all four runtime registrations match the manifest and are optional.
5. Test the temporary scaffold hook blocks every Nango tool and every
   placeholder execution returns `not_implemented` without I/O.
6. Verify the tests fail because the package is absent.

**GREEN**

1. Add TypeScript ESM metadata and a minimal `definePluginEntry` entry with
   plugin id `nango-tools`.
2. Use focused imports from `openclaw/plugin-sdk/plugin-entry` and `typebox`.
3. Do not use the Codex plugin manifest or `openclaw/plugin-sdk/core`.
4. Register four strict placeholder tools as optional. Install a synchronous
   scaffold `before_tool_call` hook that blocks all four; each placeholder
   execute path independently returns `not_implemented` and performs no I/O.
5. Use `openclaw.install.minHostVersion` for the actual host-version floor.
   Do not add the locally ignored `compat.minGatewayVersion`.
6. Install pinned dependencies and run:

```bash
npm install
npm --workspace openclaw-plugin test -- manifest.test.ts
npm --workspace openclaw-plugin run typecheck
npm --workspace openclaw-plugin run build
npm pack --workspace openclaw-plugin --dry-run --json
```

## Task 5: Implement the shared provider registry and validation boundary

**Files:**

- Create: `openclaw-plugin/src/catalog.ts`
- Create: `openclaw-plugin/src/config.ts`
- Create: `openclaw-plugin/src/validation.ts`
- Create: `openclaw-plugin/test/catalog.test.ts`
- Create: `openclaw-plugin/test/validation.test.ts`
- Modify: `openclaw-plugin/openclaw.plugin.json`

**RED / GREEN slices:**

1. Test all 25 keys plus only the intentional `yandex` alias.
2. Test strict relative paths, decoded dot segments, encoded separators,
   fragments, absolute URLs, backslashes and Unicode/control characters.
3. Test ordered/repeated query encoding.
4. Test header allow/deny rules and body exclusivity/limits.
5. Test the strict nested plugin config for Cloud.ru, transport, pagination,
   optional Action transport and optional Disk transfer settings. Reject
   unknown properties, unresolved runtime SecretRefs and invalid cross-field
   bounds rather than silently cleaning them.
6. Test manifest `configContracts.secretInputs.paths` and sensitive UI hints
   exactly cover `cloudru.apiKey` and
   `actions.transport.secretKey`.
7. Test deterministic defaults, exact link-origin allowlists for dynamic
   amoCRM/Bitrix24 tenants, immutable runtime config and a deeply secret-free
   public projection. Do not derive security origins from catalog display
   strings or implement an ambient `process.env` fallback.

Run the matching test after each slice and the plugin suite at task end.

## Task 6: Implement result and proxy transport semantics

**Files:**

- Create: `openclaw-plugin/src/result.ts`
- Create: `openclaw-plugin/src/proxy-client.ts`
- Create: `openclaw-plugin/test/result.test.ts`
- Create: `openclaw-plugin/test/proxy-client.test.ts`

**RED / GREEN slices:**

1. Test safe URL construction and derived connection ids.
2. Test credentials are injected from runtime config, not tool parameters.
3. Test redirect rejection and complete response-header redaction.
4. Test JSON, text, binary and oversized responses.
5. Test explicit proxy metadata maps to a layer while ambiguous upstream errors
   remain `unknown_upstream`.
6. Test bounded read retries with `Retry-After`.
7. Test mutations are never retried and dispatched timeouts return
   `outcome: "unknown"`.
8. Test the total operation deadline covers request dispatch, retry waits and
   response streaming; configured byte caps are enforced on streamed bytes.

Use an injected `fetch` implementation; assertions target the real transport
envelope and policy, not mock call counts alone.

## Task 7: Implement exact per-call approvals

**Files:**

- Create: `openclaw-plugin/src/approval.ts`
- Create: `openclaw-plugin/test/approval.test.ts`
- Modify: `openclaw-plugin/src/index.ts`

**RED**

1. Test read methods return no approval.
2. Test every mutation returns only `allow-once|deny`, bounded title and
   description, derived target, correct severity and no payload/secrets.
3. Test malformed/unknown params are synchronously blocked rather than thrown.
4. Test action registry and disk transfers cannot misclassify writes as reads.
5. Test missing, forged, altered and replayed one-time approval proofs block
   execution before any I/O.

**GREEN**

1. Implement a synchronous, no-I/O `before_tool_call` policy.
2. Catch all internal classification errors and return `block: true`.
3. Set approval timeout to 120 seconds, omit legacy `timeoutBehavior`, and
   attach a one-time HMAC proof only through post-approval params.
4. Verify and atomically consume the proof inside mutating tool execution.
5. Replace the scaffold blocking hook with the production approval hook only
   after the pure policy tests pass. Keep placeholder executions fail-closed
   until Tasks 8–10 replace them with tested implementations.

## Task 8: Implement generic request and pagination tools

**Files:**

- Create: `openclaw-plugin/src/tools/request.ts`
- Create: `openclaw-plugin/src/tools/paginate.ts`
- Create: `openclaw-plugin/test/request-tool.test.ts`
- Create: `openclaw-plugin/test/paginate-tool.test.ts`
- Modify: `openclaw-plugin/src/index.ts`

**RED / GREEN slices:**

1. Test the request tool accepts every advertised method/body family and
   returns the common envelope.
2. Test amoCRM/Bitrix24 link pagination accepts only exact operator-configured
   provider origins; static Yandex origins come from the code registry.
3. Test Bitrix24 `next/start`, Disk `offset/total` and Direct
   `Page.Offset/LimitedBy` termination.
4. Test hard `maxPages`/`maxItems` caps and repeated-page loop detection.
5. Test pagination is read-only even when the underlying read API uses POST.

## Task 9: Implement Yandex Disk streaming transfers

**Files:**

- Create: `openclaw-plugin/src/tools/disk-transfer.ts`
- Create: `openclaw-plugin/test/disk-transfer.test.ts`
- Modify: `openclaw-plugin/src/index.ts`

**RED / GREEN slices:**

1. Test allowed-root resolution, traversal/symlink rejection and overwrite
   policy.
2. Test upload link acquisition then credential-free PUT.
3. Test download link acquisition and a server-side authenticated follow-link
   mode; return a clear capability error when the deployed proxy lacks it.
4. Test HTTPS-only transfer URLs, configured Yandex host-suffix allowlists,
   SSRF-safe DNS resolution, redirect caps and complete separation of
   Cloud.ru/Nango headers. Revalidate every redirect and reject arbitrary HTTPS
   hosts, loopback, private, link-local and DNS-rebinding targets.
5. Test streaming limits, temp-file atomic rename and cleanup after failures.

## Task 10: Implement Nango Action transport

**Files:**

- Create: `openclaw-plugin/src/action-registry.ts`
- Create: `openclaw-plugin/src/tools/action.ts`
- Create: `openclaw-plugin/test/action.test.ts`
- Modify: `openclaw-plugin/src/index.ts`

**RED / GREEN slices:**

1. Test only registered provider/action pairs are callable.
2. Test recommended proxy mode uses one exact configured endpoint, the
   Cloud.ru API key, derived connection and the documented bounded
   request/response envelope. Return `capability_unavailable` when no compatible
   endpoint is configured; do not assume the existing provider proxy supports
   Actions.
3. Test direct mode is disabled by default, reads the resolved Nango secret
   only from runtime configuration, and calls only the fixed
   `/action/trigger` path on the configured exact HTTPS origin with the current
   Nango headers/body contract.
4. Test action input/output limits, safe errors and mutation classification.
5. Test no secret appears in approval text, request summaries or results.

## Task 11: Add Nango Yandex Mail actions and HTTPS bridge

**Files:**

- Create: `nango-integrations/package.json`
- Create: `nango-integrations/tsconfig.json`
- Create: `nango-integrations/index.ts`
- Create: `nango-integrations/yandex-mail/actions/resolve-mailbox.ts`
- Create: `nango-integrations/yandex-mail/actions/list-messages.ts`
- Create: `nango-integrations/yandex-mail/actions/get-message.ts`
- Create: `nango-integrations/yandex-mail/actions/send-message.ts`
- Create: `nango-integrations/yandex-mail/lib/bridge.ts`
- Create: `nango-integrations/test/yandex-mail.test.ts`
- Create: `mail-bridge/package.json`
- Create: `mail-bridge/tsconfig.json`
- Create: `mail-bridge/src/auth.ts`
- Create: `mail-bridge/src/mail.ts`
- Create: `mail-bridge/src/server.ts`
- Create: `mail-bridge/test/auth.test.ts`
- Create: `mail-bridge/test/mail.test.ts`
- Create: `mail-bridge/Dockerfile`

**RED / GREEN slices:**

1. Test Zod inputs/outputs and bounded message/attachment metadata.
2. Test the action accepts no bridge URL, connection override or credentials;
   it uses only a validated HTTPS origin and HMAC secret from Nango environment
   configuration.
3. Test bridge HMAC freshness and rejection of forged/replayed requests before
   any IMAP/SMTP connection.
4. Test the bridge accepts the injected access token without returning/logging
   it and pins outbound hosts/ports to Yandex.
5. Test IMAP list/search/fetch mapping with mocked socket-library boundaries.
6. Test SMTP send, Message-ID result and idempotency marker behavior.
7. Test connection/runtime/bridge errors produce safe stable errors.

Do not deploy or run `nango dryrun` without operator credentials.

## Task 12: Add amoCRM Chats HMAC actions

**Files:**

- Create: `nango-integrations/amocrm-chats/actions/send-message.ts`
- Create: `nango-integrations/amocrm-chats/lib/signature.ts`
- Create: `nango-integrations/test/amocrm-chats.test.ts`
- Modify: `nango-integrations/index.ts`

**RED / GREEN slices:**

1. Test canonical request bytes and known HMAC fixtures.
2. Test channel credentials are read inside the Nango connection and never
   emitted.
3. Test send schema, idempotency id, response validation and safe failures.

## Task 13: Rewrite and generate all 25 skills

**Files:**

- Modify: `catalog/skills.json`
- Modify: `scripts/generate_skills.py`
- Modify: `skills/*/SKILL.md` (generated)
- Modify: `skills/*/references/endpoints.md` (generated)
- Modify: `skills/*/references/api-reference.md` (generated)
- Modify: `skills/*/scripts/nango_proxy.py` (generated)

**RED**

1. Run the baseline scenarios against current packages and retain the recorded
   failures.
2. Add structural expectations for tool names, approval workflow, pagination,
   unknown outcomes, provider docs and post-write verification.
3. Verify targeted tests fail.

**GREEN**

1. Generate concise, provider-specific skill bodies with descriptions optimized
   for routing.
2. Add verified Calendar CalDAV, Disk, Direct, Delivery and Market contracts.
3. Mark Maps personal bookmarks as lacking a confirmed public API; preserve
   customer-specific generic Nango access without inventing a route.
4. Keep all 25 ids and all generic HTTP operations.
5. Run validation and generator checks.

**Skill verification**

1. Dispatch fresh agent scenarios for Yandex, Bitrix24 and amoCRM families with
   the generated skill and relevant reference.
2. Record actual decisions in `evals/after.md`.
3. Fix guidance only for observed failures, regenerate and re-run.

## Task 14: Documentation and operator runbook

**Files:**

- Modify: `README.md`
- Create: `docs/install-openclaw-plugin.md`
- Create: `docs/deploy-nango-actions.md`
- Create: `docs/live-verification.md`

Document:

- plugin build/install/enable and `tools.allow`;
- plugin approval routing separately from exec approvals;
- OpenClaw SecretRef JSON, proxy versus direct action transport, exact proxy
  wire contract and secret placement;
- Nango compile/dryrun/deploy commands without embedding credentials;
- live smoke tests by provider family;
- exact limitations: credentials were not used, actions were not deployed,
  Maps bookmarks has no confirmed public API, and proxy follow-link/action
  endpoints require backend support; do not claim interactive external-plugin
  secret configuration without an isolated proof.

## Task 15: CI and final verification

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `requirements-dev.txt`
- Modify: `.gitignore`

**CI lanes:**

1. Python 3.10/3.12 tests and skill/generator validation.
2. Node 22 install, TypeScript typecheck, Vitest and production build.
3. Nango action typecheck/tests without deploy.
4. Mail bridge typecheck/tests and container build validation without deploy.
5. Git diff check after generation.

**Final local commands:**

```bash
python3 -m pytest -q
python3 scripts/generate_skills.py --check
python3 scripts/validate_skills.py
npm test
npm run typecheck
npm run build
git diff --check
git status --short
```

Review every statement in README against the code and test output. Push the
feature branch to the fork. Open a pull request only after the branch is green;
the PR must distinguish offline proof from live proof.
