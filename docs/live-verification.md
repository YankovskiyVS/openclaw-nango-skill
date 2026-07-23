# Live verification

Use this checklist after deployment. A green offline suite proves validation,
transport and error semantics against mocks; it does not prove that a specific
Cloud.ru route, Nango connection, OAuth scope or provider account works.

Record the timestamp, environment, provider key, connection id suffix, request
id and observed outcome for every check. Never paste tokens or full private
payloads into the report.

## 1. Offline gate

From the repository root:

```bash
python3 -m pytest -q
python3 scripts/generate_skills.py --check
python3 scripts/validate_skills.py
npm test --workspace openclaw-plugin
npm run typecheck --workspace openclaw-plugin
npm run build --workspace openclaw-plugin
(cd nango-integrations && npm test && npm run typecheck && npm run build)
(cd mail-bridge && npm test && npm run typecheck && npm run build)
git diff --check
```

Do not continue if generation changes tracked files or any suite fails.

## 2. Runtime registration

On the Gateway host:

```bash
openclaw config validate --json
openclaw plugins list --enabled --verbose
openclaw plugins inspect nango-tools --runtime --json
```

Confirm:

- plugin id is `nango-tools`;
- all four tools are registered;
- the intended agent can see them through its effective tool policy;
- `approvals.plugin` has a resolvable operator route;
- SecretRefs resolve without printing their values.

## 3. Read-only provider checks

Start with one bounded read for each connected family:

| Family | Suggested check |
| --- | --- |
| Yandex | `yandex-id` profile or one Disk listing |
| Bitrix24 | `user.current` or a one-page CRM list |
| amoCRM | `api/v4/account` or a one-page leads list |

Expected behavior:

- no approval prompt for a registered read;
- request path and provider are present in the result;
- OAuth/Nango/Cloud.ru secrets are absent;
- pagination stops at the requested item/page cap;
- an upstream provider error remains distinguishable from local validation and
  transport errors.

Also test a malformed provider key, absolute URL, encoded traversal and blocked
header. Each must fail before network I/O.

## 4. Approval proof

Use a harmless development mutation with a reversible target:

1. Call it and deny the prompt. Confirm no provider request occurs.
2. Call it again and approve once. Confirm exactly one request occurs.
3. Replay the old tool parameters/proof. Confirm it is rejected.
4. Modify one approved parameter. Confirm the old approval is rejected.
5. Let one prompt time out. Confirm the operation remains blocked.

The prompt must contain a bounded action, provider and target description. It
must not contain secrets or full private message bodies.

Plugin approvals are separate from exec approvals. A working exec approval
route is not sufficient evidence for this test.

## 5. Pagination contracts

Exercise only the provider contracts supported by the registry:

- amoCRM same-origin `_links.next.href`;
- Yandex Disk offset;
- Yandex Market `pageToken`;
- Yandex Direct JSON body `Page.Offset`;
- registered Bitrix24 `next`/`start`;
- single-page Calendar or other explicitly non-pageable reads.

Confirm that an amoCRM next link cannot change the origin or collection path,
that a repeated cursor terminates as a loop, and that the aggregate result
stops at byte, item and page caps.

## 6. Yandex Mail

Before any send:

1. Check bridge health at the deployment layer without exposing its shared
   secret.
2. Run `resolve-mailbox`.
3. List one message from `INBOX`.
4. Fetch one small, non-sensitive test message.
5. Confirm custom-domain mailbox resolution if that is the production account
   type.

For a send, use a dedicated recipient and unique idempotency key. Verify the
Message-ID in the provider mailbox. Repeating the same key and identical body
must return the cached confirmation without a second SMTP send. Reusing the key
with a different body must fail before SMTP.

If the result is `unknown`, stop. Inspect Sent mail and the recipient before
deciding whether a new idempotency key is safe.

## 7. amoCRM Chats

Verify OAuth Talks reads through `amocrm-chats` separately from channel sends.
The send Action must execute through internal integration
`amocrm-chats-channel`; the caller must not be able to override that key,
`scope_id`, region, channel secret or sender identity.

Send one text message with a unique `msgid`, then verify it in amoCRM. Do not
automatically retry an `unknown` result. Repeating the same `msgid` and body
must return the cached confirmation without another provider request. Reusing
the same `msgid` with different text must fail before dispatch. Also issue two
concurrent calls with a dedicated test `msgid`; exactly one provider message
may appear, while the competing call remains conservative.

Inbound channel webhooks are outside this repository's implementation and are
not part of this check.

## 8. Yandex Disk transfer

Use small fixtures inside dedicated configured roots:

1. Upload a known file and compare returned size/SHA-256 with the local file.
2. Download it to a new path and compare size/SHA-256.
3. Attempt traversal, a symlink path, overwrite without the intended flag and
   a file outside the root; each must fail locally.
4. Verify redirects remain within configured Yandex transfer suffixes and
   resolve only to public addresses.
5. Interrupt a download and confirm no partial destination is published.

Disk transfer never returns the pre-signed transfer URL to the model and never
forwards Cloud.ru or Nango headers to the transfer host.

## 9. Record limitations

Keep these claims explicit until separately proven:

- this repository's automated tests use mocks and local fixtures;
- a successful build is not a live credential test;
- Yandex Maps personal bookmarks has no confirmed public API route here;
- the Action proxy endpoint is a repository-defined backend contract and may
  be unavailable in the deployed Cloud.ru proxy;
- Nango Actions and the mail bridge require separate deployment;
- an `unknown` mutation outcome must be reconciled at the provider before
  retry.
