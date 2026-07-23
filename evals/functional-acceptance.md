# Functional acceptance

Date: 2026-07-23

This report separates reproducible isolated evidence from checks that still
require a deployed OpenClaw Gateway, Nango, OAuth connections, and provider
accounts. A passing isolated suite is not presented as live-provider proof.

## Accepted surface

The generated catalog contains:

- 25 skill packages;
- 40 documented operations;
- 33 operations marked ready;
- 28 operations with concrete compatibility-client commands;
- 5 ready operations using registered `nango_action` tools (these categories
  are not mutually exclusive);
- 5 typed-tool templates;
- 1 explicitly unsupported Yandex Maps bookmark operation;
- 1 blocked Yandex Delivery create operation whose public contract is not
  sufficiently specified;
- 31 catalog-to-skill behavioral regression cases.

All 25 skill ids and provider configuration keys are preserved.

## Proven in isolation

### Packaged Python fallback

`tests/test_skill_runtime_acceptance.py` starts a loopback
`ThreadingHTTPServer` and invokes the actual `nango_proxy.py` copied into every
skill package. It does not replace the subprocess or HTTP client with a mocked
return value.

The acceptance suite proves:

- every concrete ready command emits the expected method, path, ordered query,
  headers, body, and provider key;
- all 25 packaged script copies can execute the health path without leaking
  authorization or sending an unintended body;
- malformed historical Yandex Direct and Yandex Delivery examples are rejected
  before network I/O, so the harness is known to detect an actual upstream
  failure;
- response envelopes and diagnostic output redact authorization and sensitive
  header values;
- executable examples distinguish JSON APIs, CalDAV XML, Yandex Direct JSON
  RPC, typed-only adapters, and intentionally unavailable contracts.

Fresh result on both Python 3.10 and Python 3.12: `265 passed` per interpreter.

### OpenClaw plugin

The acceptance fixtures register the real plugin entrypoint and execute the
real OpenClaw hook/tool path against loopback HTTP servers. The default Undici
transport is used for the transport-specific checks.

The suite proves:

- registered reads execute without approval;
- an allow-once mutation can dispatch once and cannot be replayed;
- pending, denied, expired, path-modified, and body-modified approvals produce
  no network I/O;
- a dispatched transport failure returns `unknown`, and replay remains blocked;
- bounded multi-page reads preserve the intended cursor sequence;
- binary upload/download bytes survive the default transport;
- DNS lookup pinning, `Host` handling, response caps, redaction, and socket
  closure are exercised.

Fresh result: `492 passed`; typecheck and build also pass. `npm pack --dry-run`
contains 26 entries, with a 54,105-byte tarball and 288,892 unpacked bytes.

The suite imports OpenClaw's pinned SDK and real hook dispatcher, but it does
not start an operator Gateway. The Gateway RPC implementation of
`plugin.approval.request` / `waitDecision` and production host policy wiring
remain live-verification items.

### Nango Actions and mail bridge

The cross-package acceptance suite uses real loopback TLS listeners and exact
wire bytes. Provider and SMTP dispatch are represented by stateful local
transports so that no credentials or external mutation are required.

It proves:

- the official Nango compiler emits exactly two distinct integrations and five
  declared CommonJS Action bundles;
- Yandex Mail Action input reaches the production bridge handler with a valid
  timestamp, nonce, digest, and HMAC;
- replay, idempotency cache, conflicting reuse, SMTP dispatch count, and output
  schemas behave conservatively;
- amoCRM Chats signs the exact outgoing body and records pending, confirmed,
  cached, conflict, and sticky unknown outcomes;
- Redis startup, outage, reconnect, eval failure, and connect/end race paths
  fail closed without accidental provider dispatch;
- the dedicated Redis 7.4 service gate uses two independent production
  `createConfiguredStore` paths and real Lua `EVAL` responses to exercise
  atomic nonce consumption, concurrent begin, conflict, confirm-to-cache,
  mismatched transitions, and sticky unknown state.

Fresh checkout results:

- standalone Nango unit tests: `75 passed`;
- cross-package TLS E2E: `2 passed`;
- mail bridge: `33 passed`;
- Nango typecheck, E2E typecheck, and both package builds: exit 0;
- clean-environment official compile: 2 distinct integrations, 5 versioned
  Actions, and 5 exact build artifacts.

## Model-in-the-loop evaluation

Ten paired planning cases used fresh agents with either the current skill or
the upstream skill text loaded. The cases covered a normal read, bounded
pagination, semantic POST read, mutation approval, unknown outcome,
Yandex Mail, Disk transfer, CalDAV, unsupported Maps, and blocked Delivery.

- current skill text: 80/80 planning-rubric checks and 10/10 expected
  registered-tool-or-safe-null boundaries;
- upstream skill text: 48/80 planning-rubric checks and 1/10 expected
  registered-tool-or-safe-null boundaries;
- the per-case comparison has 9 current wins and 1 safety tie: upstream also
  refused to invent a Yandex Maps endpoint;
- a separate name-and-description routing screen selected the expected skill
  in 24/24 current cases and 24/24 upstream cases.

The exact stored prompts, raw answers, per-assertion evidence, routing outputs,
and arithmetic integrity test are documented in
[`model-functional/README.md`](model-functional/README.md).

This is one run per variant, with the candidate skill forced into context. It
tests instruction usefulness, not natural trigger probability, statistical
variance, runtime schema validation, or provider success. The equal routing
score means this run does not support a claim that the new descriptions alone
improve skill triggering. For cases 05–10, the exact authored prompt texts are
stored, but the raw child-agent artifact did not independently retain the task
payload and therefore cannot prove byte-for-byte prompt identity.

## Intentionally unsupported

- Yandex Maps personal bookmarks: no authoritative public API contract is
  registered, so the skill refuses instead of inventing a route.
- Yandex Delivery order creation: the available contract is ambiguous, so the
  mutation remains blocked instead of issuing a guessed POST.

The generic compatibility client remains available for operator-specified
provider contracts; removing these two unsafe examples did not remove that
generic capability.

## Not live tested

This acceptance run does not prove:

- real OAuth scope or token validity;
- Cloud.ru proxy route availability;
- a deployed Nango Action runner;
- a deployed OpenClaw Gateway approval prompt;
- real Yandex, Bitrix24, or amoCRM responses;
- real IMAP/SMTP delivery or provider-side reconciliation;
- operator DNS/firewall/SecretRef configuration.

No `.env`, OAuth connection, provider credential, Nango deployment, or real
provider state is read or changed. Live verification must follow
`docs/live-verification.md` after deployment and must record provider-visible
results without exposing secrets.

Production dependency audits report zero known vulnerabilities in the root
workspace, Nango package, and mail bridge. The local Docker daemon was not
available, and no local Redis server was installed, so the container build and
real Redis/Lua compatibility test remain GitHub Actions gates.

## Final regression gate

Before publication, rerun from the checked-out revision:

```bash
uv run --python 3.10 --with-requirements requirements-dev.txt \
  python -m pytest -p no:cacheprovider tests -q
uv run --python 3.12 --with-requirements requirements-dev.txt \
  python -m pytest -p no:cacheprovider tests -q
python3 scripts/generate_skills.py --check
python3 scripts/validate_skills.py

npm ci
npm test --workspace openclaw-plugin
npm run typecheck --workspace openclaw-plugin
npm run build --workspace openclaw-plugin
npm pack --dry-run --json --workspace openclaw-plugin

cd nango-integrations
npm ci
npm run verify:nango
npm run test:unit
npm run typecheck
npm run build

cd ../mail-bridge
npm ci
npm test
npm run typecheck
npm run build

cd ../nango-integrations
npm run test:e2e
npm run typecheck:e2e

# With a dedicated disposable Redis listening on this exact test URL:
cd ../mail-bridge
MAIL_BRIDGE_TEST_REDIS_URL=redis://127.0.0.1:6379 npm run test:redis
```

The GitHub Actions run supplies the disposable Redis service and is also the
Docker build gate when those local services are unavailable.
