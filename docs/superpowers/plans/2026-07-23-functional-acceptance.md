# OpenClaw Nango Skills Functional Acceptance Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce reproducible evidence that the generated skills, OpenClaw tools, Nango Actions, and mail bridge execute their documented contracts without relying only on static checks or mocked return values.

**Architecture:** Keep live providers and credentials outside this acceptance run. Exercise real package entrypoints and wire formats against local ephemeral HTTP services, compare model behavior with the upstream skill text, and record unsupported provider contracts as unsupported rather than manufacturing success.

**Tech Stack:** Python 3.10/3.12, pytest, Node.js 22, Vitest, OpenClaw plugin SDK 2026.6.11, local HTTP listeners, Docker build in GitHub Actions.

## Global Constraints

- Do not read or modify `.env`, OAuth credentials, provider connections, or deployed Nango state.
- Do not run the OpenClaw CLI; import the pinned plugin SDK and plugin entrypoint in-process.
- Do not make live provider requests or perform real mutations.
- Preserve all 25 skill ids, provider keys, and generic HTTP fallback capability.
- Treat Yandex Maps bookmarks and the ambiguous Yandex Delivery create contract as unavailable until an authoritative contract exists.
- Any production fix starts with a failing regression test.
- Report isolated acceptance separately from live-provider verification.

---

### Task 1: Catalog-to-runtime acceptance inventory

**Files:**
- Read: `catalog/skills.json`
- Read: `evals/skill-cases.json`
- Modify after execution: `evals/functional-acceptance.md`

**Interfaces:**
- Consumes: 25 skill records, 40 catalog operations, 31 existing behavioral cases.
- Produces: a matrix separating ready fallback commands, typed-only operations, templates, and intentionally blocked operations.

- [ ] **Step 1: Count and classify every operation**

Run:

```bash
jq '{skills:(.skills|length), operations:([.skills[].operations|length]|add), ready:([.skills[].operations[]|select(.availability=="ready")]|length), templates:([.skills[].operations[]|select(.availability=="template")]|length), blocked:([.skills[].operations[]|select(.availability=="unsupported" or .availability=="blocked_contract")]|length)}' catalog/skills.json
```

Expected: 25 skills and 40 total operations with no unclassified operation.

- [ ] **Step 2: Verify every existing eval case maps to one catalog skill and expected tool**

Run:

```bash
python -m pytest -q tests/test_skill_cases.py tests/test_generate_skills.py
```

Expected: PASS, then record that these tests prove generated-text consistency rather than runtime execution.

### Task 2: Python fallback black-box execution

**Files:**
- Create: `tests/test_skill_runtime_acceptance.py`
- Read: `_shared/scripts/nango_proxy.py`
- Read: `skills/*/scripts/nango_proxy.py`

**Interfaces:**
- Consumes: each ready catalog operation with a concrete `command`.
- Produces: observed HTTP method, path, ordered query, body, authorization header, exit code, and JSON envelope for every executed package command.

- [ ] **Step 1: Write a parametrized subprocess acceptance test**

The test must:

```python
def test_every_ready_fallback_command_round_trips_through_fake_proxy(
    fake_proxy,
    operation,
):
    result = run_bundled_command(operation, fake_proxy.url)
    assert result.returncode == 0
    assert fake_proxy.last_request.matches(operation)
    assert json.loads(result.stdout)["outcome"] == "confirmed"
```

It must start a loopback `ThreadingHTTPServer`, execute the actual script from the matching `skills/<id>/scripts/` directory, and reject any unexpected request.

- [ ] **Step 2: Verify the test detects the upstream broken examples**

Run the same command parser against the upstream Yandex Direct and Delivery examples.

Expected: the historical double-brace JSON examples fail before I/O, proving the acceptance test detects a real baseline defect.

- [ ] **Step 3: Run on Python 3.10 and 3.12**

Run:

```bash
uv run --python 3.10 --with-requirements requirements-dev.txt python -m pytest -q tests/test_skill_runtime_acceptance.py
uv run --python 3.12 --with-requirements requirements-dev.txt python -m pytest -q tests/test_skill_runtime_acceptance.py
```

Expected: all concrete ready commands pass on both versions; blocked/template operations are not executed.

### Task 3: OpenClaw plugin end-to-end path

**Files:**
- Create: `openclaw-plugin/test/end-to-end.test.ts`
- Read: `openclaw-plugin/src/index.ts`
- Read: `openclaw-plugin/src/approval.ts`

**Interfaces:**
- Consumes: the real plugin registration API, hook result, tool definitions, and local HTTP proxy.
- Produces: one trace from hook decision through real HTTP bytes and back to the model-visible structured result.

- [ ] **Step 1: Add a local HTTP proxy acceptance fixture**

Use `node:http` with an ephemeral loopback port. Capture method, URL, headers, and body; never mock `globalThis.fetch` for the primary request-path scenario.

- [ ] **Step 2: Prove a read executes without approval**

Register the plugin with the local proxy URL, invoke `before_tool_call`, then execute `nango_proxy_request`.

Expected: no approval request, exactly one HTTP request, correct Cloud.ru route, redacted result.

- [ ] **Step 3: Prove a mutation cannot execute before approval and can execute once**

Call the real hook with one tool-call id, resolve `allow-once`, execute the hook-adjusted params, then replay them.

Expected: zero I/O before approval, one I/O after approval, replay returns `approval_required`.

- [ ] **Step 4: Prove pagination and unknown-outcome behavior**

Serve deterministic multi-page Bitrix24 and amoCRM responses and a dispatched timeout.

Expected: bounded termination reason and cursor sequence are correct; a timed-out mutation returns `unknown` and is not retried.

### Task 4: Nango Action and mail bridge acceptance

**Files:**
- Create: `nango-integrations/test/end-to-end.test.ts`
- Modify only if a defect is reproduced: `nango-integrations/**`, `mail-bridge/**`

**Interfaces:**
- Consumes: actual Action exports, bridge HMAC request contract, and shared idempotency metadata/lock APIs.
- Produces: observed signed HTTP request, verified bridge response, replay behavior, and stable mutation outcome.

- [ ] **Step 1: Run Action-to-bridge through a real local HTTP listener**

The fake listener verifies timestamp, nonce, body digest, and HMAC before returning a bounded mail result.

Expected: `list-messages` and `send-message` Action outputs match the registered plugin schemas.

- [ ] **Step 2: Exercise amoCRM send idempotency with a stateful fake Nango client**

Expected: first confirmed send writes the ledger; identical replay returns cached confirmation; conflicting reuse fails; uncertain dispatch remains sticky.

- [ ] **Step 3: Verify package and container artifacts**

Run:

```bash
npm pack --dry-run --json
npm test && npm run typecheck && npm run build
```

Expected: required runtime files are packaged and build output imports without source-only paths. Docker remains a GitHub runner gate when the local daemon is unavailable.

### Task 5: Model-in-loop skill evaluation

**Files:**
- Read: `skills/*/SKILL.md`
- Read baseline via: `git show upstream/main:skills/<id>/SKILL.md`
- Write outside source tree: `/tmp/openclaw-nango-skill-eval/iteration-1/`
- Summarize: `evals/functional-acceptance.md`

**Interfaces:**
- Consumes: realistic prompts, current skill text, and upstream skill text.
- Produces: exact selected skill, tool, arguments, approval behavior, verification step, and refusal behavior.

- [ ] **Step 1: Run paired baseline/current agents**

Cover at minimum: ordinary read, bounded pagination, semantic POST read, mutation approval, unknown mutation outcome, Yandex Mail send, Disk transfer, CalDAV, unsupported Maps, and blocked Delivery.

Expected: runs with the current skill choose the registered tool and safety path; upstream runs expose the previously documented gaps.

- [ ] **Step 2: Grade objective assertions**

Each `grading.json` must use:

```json
{"expectations":[{"text":"Uses the exact provider key","passed":true,"evidence":"..."}]}
```

Grade tool choice, provider key, mutation approval, retry behavior, verification, and refusal to invent unsupported endpoints.

- [ ] **Step 3: Generate the static review artifact**

Run the skill-creator viewer in static mode and keep raw transcripts outside the repository. Record the aggregate and limitations in the acceptance report.

### Task 6: Regression and handoff gate

**Files:**
- Modify: `evals/functional-acceptance.md`
- Modify production files only for reproduced defects.

- [ ] **Step 1: Fix each reproduced defect test-first**

For every failure: preserve the failing test output, apply the smallest fix, and run the focused test before the full suite.

- [ ] **Step 2: Run the complete matrix**

Run Python 3.10/3.12, all three Node workspaces, generator check, 25-skill validator, package dry-run, dependency audits, and GitHub CI including Docker.

- [ ] **Step 3: Publish an evidence-based verdict**

The report must separate:

```text
PROVEN ISOLATED
PROVEN MODEL-IN-LOOP
NOT LIVE TESTED
INTENTIONALLY UNSUPPORTED
```

Do not claim live OAuth/provider compatibility without a separately approved credentialed smoke test.
