# Skill evaluation after instruction hardening

Date: 2026-07-23

Upstream baseline: `12903d917509fab4a4da4d7dd0489a42c00286e6`

This is a fresh static evaluation of the regenerated 25 skill packages against
`evals/skill-cases.json`.

## Fresh observations

- All 25 existing skill ids and `providerConfigKey` values remain unchanged.
- Every `nango_proxy_paginate` skill now tells the agent to return the bounded
  pages and termination reason and not claim completeness when a configured
  bound stops the read.
- Bitrix24 pagination explicitly maps the provider `next` value to the next
  request's `start`.
- amoCRM link pagination explicitly follows only verified same-origin next
  links within bounds.
- Yandex Direct body pagination explicitly advances `Page.Offset`, preserves
  `Page.Limit`, and returns the terminal page and termination reason.
- A confirmed Yandex Direct mutation now requires a campaign read and field
  comparison. An uncertain dispatch requires state inspection before retry.
- Bitrix24 CRM now includes a primary typed `crm.deal.update` recipe. Confirmed
  updates require `crm.deal.get` verification; uncertain dispatch requires
  inspecting the same deal before retry.
- The amoCRM Chats endpoint reference now records the registered
  `nango_action` `send-message` path and its message-id/unknown-outcome
  verification.
- The canonical API reference now matches the compatibility client's supported
  methods and flags and documents all four typed plugin tools, exact mutation
  approval, result outcomes, and the operator-only fallback boundary.

## Regression coverage

The regression suite now reads the actual eval cases and generated artifacts.
It checks the common pagination result contract, Bitrix24 and amoCRM cursor
safety, Direct and Bitrix24 post-write verification, Chats action references,
and agreement between the canonical fallback implementation and reference.

Fresh offline results:

- `python3 -m pytest -p no:cacheprovider tests -q` — 172 passed.
- `python3 scripts/generate_skills.py --check` — generated files are up to date.
- `python3 scripts/validate_skills.py` — validated 25 skills.

## Offline boundary

`STATIC` and `NOT LIVE TESTED`: no `.env`, provider credentials, OpenClaw CLI,
Nango deployment, network request, or live provider API was used. These results
show that the generated instructions match the repository eval contract; they
do not claim live provider compatibility.
