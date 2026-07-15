#!/usr/bin/env python3
"""Generate granular OpenClaw skills from the marketplace catalog."""

from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHARED = ROOT / "_shared"
SKILLS = ROOT / "skills"

# Each entry becomes skills/<id>/ — one OpenClaw skill, one Nango provider_config_key.
CATALOG: list[dict] = [
    # --- Yandex ---
    {
        "id": "yandex-id",
        "name": "yandex-id",
        "title": "Yandex ID",
        "family": "yandex",
        "provider_config_key": "yandex-id",
        "aliases": ["yandex"],
        "description": "Call Yandex ID (login.info/email/avatar) via Nango proxy after OAuth connect",
        "when": "User asks about Yandex profile, login, email, avatar, or account identity.",
        "scopes": "login:info, login:email, login:avatar",
        "base": "https://login.yandex.ru",
        "examples": [
            ('GET profile', 'call yandex-id info --query \'format=json\' --json-output'),
            ('legacy key', 'call yandex info --query \'format=json\' --json-output'),
        ],
        "notes": "Legacy Nango unique key `yandex` still works if that is what was connected.",
    },
    {
        "id": "yandex-disk",
        "name": "yandex-disk",
        "title": "Yandex Disk",
        "family": "yandex",
        "provider_config_key": "yandex-disk",
        "description": "Call Yandex Disk REST API via Nango proxy after OAuth connect",
        "when": "User asks to list/upload/download files on Yandex Disk.",
        "scopes": "cloud_api:disk.read, cloud_api:disk.write, cloud_api:disk.info, cloud_api:disk.app_folder",
        "base": "https://cloud-api.yandex.net",
        "examples": [
            ('Disk meta', 'call yandex-disk v1/disk --json-output'),
            ('List root', 'call yandex-disk \'v1/disk/resources\' --query \'path=/\' --json-output'),
        ],
        "notes": "Docs: https://yandex.com/dev/disk/api/concepts/about.html",
    },
    {
        "id": "yandex-mail",
        "name": "yandex-mail",
        "title": "Yandex Mail",
        "family": "yandex",
        "provider_config_key": "yandex-mail",
        "description": "Use Yandex Mail OAuth token (IMAP/SMTP XOAUTH2) obtained via Nango",
        "when": "User asks to read or send Yandex Mail.",
        "scopes": "mail:imap_full, mail:smtp, login:email",
        "base": "https://login.yandex.ru (identity); mail via IMAP/SMTP",
        "examples": [
            ('Resolve mailbox email', 'call yandex-mail info --query \'format=json\' --json-output'),
        ],
        "notes": "HTTP proxy does not speak IMAP. Use token with XOAUTH2 on imap.yandex.com / smtp.yandex.com.",
    },
    {
        "id": "yandex-calendar",
        "name": "yandex-calendar",
        "title": "Yandex Calendar",
        "family": "yandex",
        "provider_config_key": "yandex-calendar",
        "description": "Call Yandex Calendar CalDAV API via Nango proxy after OAuth connect",
        "when": "User asks about Yandex Calendar events, availability, or meetings.",
        "scopes": "calendar:all",
        "base": "https://caldav.yandex.ru",
        "examples": [
            ('CalDAV root', 'call yandex-calendar calendars/ --json-output'),
        ],
        "notes": "CalDAV (ICS), not Google Calendar JSON API.",
    },
    {
        "id": "yandex-direct",
        "name": "yandex-direct",
        "title": "Yandex Direct",
        "family": "yandex",
        "provider_config_key": "yandex-direct",
        "description": "Call Yandex Direct API via Nango proxy after OAuth connect",
        "when": "User asks about Yandex Direct campaigns, ads, or reports.",
        "scopes": "direct:api",
        "base": "https://api.direct.yandex.com",
        "examples": [
            ('JSON v5 campaigns', 'call yandex-direct json/v5/campaigns --method POST --json \'{"method":"get","params":{"SelectionCriteria":{},"FieldNames":["Id","Name"]}}\' --json-output'),
        ],
        "notes": "Upstream auth header is Bearer (set by Nango provider template).",
    },
    {
        "id": "yandex-maps",
        "name": "yandex-maps",
        "title": "Yandex Maps",
        "family": "yandex",
        "provider_config_key": "yandex-maps",
        "description": "Call Yandex Maps (bookmarks scope) via Nango proxy after OAuth connect",
        "when": "User asks about Yandex Maps bookmarks / saved places (msps:public_bookmarks).",
        "scopes": "msps:public_bookmarks",
        "base": "https://api-maps.yandex.ru",
        "examples": [
            ('After OAuth, call Maps endpoints as documented for bookmarks API', 'call yandex-maps v1/ --json-output'),
        ],
        "notes": "Exact bookmark REST paths depend on Maps product API; keep OAuth connection scoped to bookmarks.",
    },
    {
        "id": "yandex-market",
        "name": "yandex-market",
        "title": "Yandex Market Partner",
        "family": "yandex",
        "provider_config_key": "yandex-market",
        "description": "Call Yandex Market Partner API via Nango proxy after OAuth connect",
        "when": "User asks about Market partner campaigns, offers, or partner cabinet data.",
        "scopes": "market:partner-api",
        "base": "https://api.partner.market.yandex.ru",
        "examples": [
            ('Campaigns v2', 'call yandex-market v2/campaigns --json-output'),
        ],
        "notes": "Market prefers Api-Key for new apps; OAuth still works for transitional setups.",
    },
    {
        "id": "yandex-delivery",
        "name": "yandex-delivery",
        "title": "Yandex Delivery Partner",
        "family": "yandex",
        "provider_config_key": "yandex-delivery",
        "description": "Call Yandex Delivery Partner API via Nango proxy after OAuth connect",
        "when": "User asks about Yandex Delivery offers, claims, or partner logistics API.",
        "scopes": "delivery:partner-api",
        "base": "https://b2b.taxi.yandex.net",
        "examples": [
            ('Platform probe', 'call yandex-delivery api/b2b/platform/offers/create --method POST --json \'{}\' --json-output'),
        ],
        "notes": "Upstream auth header is Bearer (set by Nango provider template).",
    },
    # --- Bitrix24 ---
    {
        "id": "bitrix24",
        "name": "bitrix24",
        "title": "Bitrix24",
        "family": "bitrix24",
        "provider_config_key": "bitrix24",
        "description": "Call Bitrix24 REST (base user scope) via Nango proxy after OAuth connect",
        "when": "User asks generic Bitrix24 requests; prefer module skills (crm/tasks/…) when available.",
        "scopes": "user",
        "base": "https://{domain}/rest",
        "examples": [
            ('Current user', 'call bitrix24 user.current --json-output'),
        ],
        "notes": "Connect requires Bitrix24 portal domain. Install module-specific skills when those integrations are connected.",
    },
    {
        "id": "bitrix24-crm",
        "name": "bitrix24-crm",
        "title": "Bitrix24 CRM",
        "family": "bitrix24",
        "provider_config_key": "bitrix24-crm",
        "description": "Call Bitrix24 CRM REST (leads, deals, contacts) via Nango proxy",
        "when": "User asks about Bitrix24 leads, deals, contacts, companies, invoices, SPA.",
        "scopes": "crm",
        "base": "https://{domain}/rest",
        "examples": [
            ('List leads', 'call bitrix24-crm crm.lead.list --json-output'),
            ('List deals', 'call bitrix24-crm crm.deal.list --json-output'),
        ],
        "notes": "Requires OAuth connection for provider_config_key bitrix24-crm.",
    },
    {
        "id": "bitrix24-tasks",
        "name": "bitrix24-tasks",
        "title": "Bitrix24 Tasks",
        "family": "bitrix24",
        "provider_config_key": "bitrix24-tasks",
        "description": "Call Bitrix24 Tasks / Projects REST via Nango proxy",
        "when": "User asks about Bitrix24 tasks, checklists, comments, projects/groups.",
        "scopes": "task, tasks_extended, sonet_group",
        "base": "https://{domain}/rest",
        "examples": [
            ('List tasks', 'call bitrix24-tasks tasks.task.list --json-output'),
        ],
        "notes": "",
    },
    {
        "id": "bitrix24-disk",
        "name": "bitrix24-disk",
        "title": "Bitrix24 Disk",
        "family": "bitrix24",
        "provider_config_key": "bitrix24-disk",
        "description": "Call Bitrix24 Disk REST via Nango proxy",
        "when": "User asks about Bitrix24 Drive files, folders, public links.",
        "scopes": "disk",
        "base": "https://{domain}/rest",
        "examples": [
            ('Storage list', 'call bitrix24-disk disk.storage.getlist --json-output'),
        ],
        "notes": "",
    },
    {
        "id": "bitrix24-im",
        "name": "bitrix24-im",
        "title": "Bitrix24 Messenger",
        "family": "bitrix24",
        "provider_config_key": "bitrix24-im",
        "description": "Call Bitrix24 Messenger / chatbots / open lines via Nango proxy",
        "when": "User asks to send Bitrix24 chat messages, manage chatbots, or open lines.",
        "scopes": "im, imbot, imopenlines",
        "base": "https://{domain}/rest",
        "examples": [
            ('Recent dialogs', 'call bitrix24-im im.recent.get --json-output'),
        ],
        "notes": "",
    },
    {
        "id": "bitrix24-user",
        "name": "bitrix24-user",
        "title": "Bitrix24 Users & Structure",
        "family": "bitrix24",
        "provider_config_key": "bitrix24-user",
        "description": "Call Bitrix24 user and company structure REST via Nango proxy",
        "when": "User asks about Bitrix24 employees, departments, org chart.",
        "scopes": "user, department",
        "base": "https://{domain}/rest",
        "examples": [
            ('Current user', 'call bitrix24-user user.current --json-output'),
            ('Departments', 'call bitrix24-user department.get --json-output'),
        ],
        "notes": "",
    },
    {
        "id": "bitrix24-calendar",
        "name": "bitrix24-calendar",
        "title": "Bitrix24 Calendar",
        "family": "bitrix24",
        "provider_config_key": "bitrix24-calendar",
        "description": "Call Bitrix24 Calendar REST via Nango proxy",
        "when": "User asks about Bitrix24 calendar, meetings, room booking.",
        "scopes": "calendar",
        "base": "https://{domain}/rest",
        "examples": [
            ('Section list', 'call bitrix24-calendar calendar.section.get --json-output'),
        ],
        "notes": "",
    },
    {
        "id": "bitrix24-bizproc",
        "name": "bitrix24-bizproc",
        "title": "Bitrix24 Business Processes",
        "family": "bitrix24",
        "provider_config_key": "bitrix24-bizproc",
        "description": "Call Bitrix24 business processes / robots REST via Nango proxy",
        "when": "User asks to start or inspect Bitrix24 workflows, robots, or bizproc.",
        "scopes": "bizproc",
        "base": "https://{domain}/rest",
        "examples": [
            ('Workflow templates', 'call bitrix24-bizproc bizproc.workflow.template.list --json-output'),
        ],
        "notes": "",
    },
    {
        "id": "bitrix24-telephony",
        "name": "bitrix24-telephony",
        "title": "Bitrix24 Telephony",
        "family": "bitrix24",
        "provider_config_key": "bitrix24-telephony",
        "description": "Call Bitrix24 telephony / call-tracking REST via Nango proxy",
        "when": "User asks about Bitrix24 calls, call records, or telephony.",
        "scopes": "telephony, call",
        "base": "https://{domain}/rest",
        "examples": [
            ('External lines', 'call bitrix24-telephony telephony.externalLine.get --json-output'),
        ],
        "notes": "",
    },
    # --- amoCRM ---
    {
        "id": "amocrm",
        "name": "amocrm",
        "title": "amoCRM",
        "family": "amocrm",
        "provider_config_key": "amocrm",
        "description": "Call amoCRM REST via Nango proxy after OAuth connect",
        "when": "User asks generic amoCRM questions; prefer module skills when installed.",
        "scopes": "account data (coarse OAuth scopes in amoМаркет)",
        "base": "https://{subdomain}.amocrm.ru",
        "examples": [
            ('Account', 'call amocrm api/v4/account --json-output'),
        ],
        "notes": "amoCRM OAuth scopes are coarse; module skills are separate apps for UX/isolation.",
    },
    {
        "id": "amocrm-crm",
        "name": "amocrm-crm",
        "title": "amoCRM Deals & Pipeline",
        "family": "amocrm",
        "provider_config_key": "amocrm-crm",
        "description": "Call amoCRM deals/contacts/pipelines via Nango proxy",
        "when": "User asks about amoCRM deals, contacts, companies, pipelines, stages.",
        "scopes": "account data (selected in amoМаркет)",
        "base": "https://{subdomain}.amocrm.ru",
        "examples": [
            ('Leads', 'call amocrm-crm api/v4/leads --json-output'),
            ('Contacts', 'call amocrm-crm api/v4/contacts --json-output'),
        ],
        "notes": "",
    },
    {
        "id": "amocrm-catalog",
        "name": "amocrm-catalog",
        "title": "amoCRM Catalog & Purchases",
        "family": "amocrm",
        "provider_config_key": "amocrm-catalog",
        "description": "Call amoCRM catalog/products/purchases via Nango proxy",
        "when": "User asks about amoCRM products, catalogs, purchases.",
        "scopes": "account data",
        "base": "https://{subdomain}.amocrm.ru",
        "examples": [
            ('Catalogs', 'call amocrm-catalog api/v4/catalogs --json-output'),
        ],
        "notes": "",
    },
    {
        "id": "amocrm-chats",
        "name": "amocrm-chats",
        "title": "amoCRM Chats",
        "family": "amocrm",
        "provider_config_key": "amocrm-chats",
        "description": "Call amoCRM chats / messaging integrations via Nango proxy",
        "when": "User asks about amoCRM chats, messengers, inbound channels.",
        "scopes": "account data",
        "base": "https://{subdomain}.amocrm.ru",
        "examples": [
            ('Talks', 'call amocrm-chats api/v4/talks --json-output'),
        ],
        "notes": "",
    },
    {
        "id": "amocrm-telephony",
        "name": "amocrm-telephony",
        "title": "amoCRM Telephony",
        "family": "amocrm",
        "provider_config_key": "amocrm-telephony",
        "description": "Call amoCRM telephony / call events via Nango proxy",
        "when": "User asks about amoCRM calls, telephony, call records.",
        "scopes": "account data",
        "base": "https://{subdomain}.amocrm.ru",
        "examples": [
            ('Events notes', 'call amocrm-telephony api/v4/events --query \'filter[type]=incoming_call\' --json-output'),
        ],
        "notes": "",
    },
    {
        "id": "amocrm-tasks",
        "name": "amocrm-tasks",
        "title": "amoCRM Tasks & Calendar",
        "family": "amocrm",
        "provider_config_key": "amocrm-tasks",
        "description": "Call amoCRM tasks via Nango proxy",
        "when": "User asks about amoCRM tasks, reminders, calendar-like follow-ups.",
        "scopes": "account data",
        "base": "https://{subdomain}.amocrm.ru",
        "examples": [
            ('Tasks', 'call amocrm-tasks api/v4/tasks --json-output'),
        ],
        "notes": "",
    },
    {
        "id": "amocrm-events",
        "name": "amocrm-events",
        "title": "amoCRM Events & Feed",
        "family": "amocrm",
        "provider_config_key": "amocrm-events",
        "description": "Call amoCRM events / activity feed via Nango proxy",
        "when": "User asks about amoCRM activity history, notes, change feed.",
        "scopes": "account data",
        "base": "https://{subdomain}.amocrm.ru",
        "examples": [
            ('Events', 'call amocrm-events api/v4/events --json-output'),
        ],
        "notes": "",
    },
    {
        "id": "amocrm-users",
        "name": "amocrm-users",
        "title": "amoCRM Users & Structure",
        "family": "amocrm",
        "provider_config_key": "amocrm-users",
        "description": "Call amoCRM users / account structure via Nango proxy",
        "when": "User asks about amoCRM managers, groups, account users.",
        "scopes": "account data",
        "base": "https://{subdomain}.amocrm.ru",
        "examples": [
            ('Users', 'call amocrm-users api/v4/users --json-output'),
        ],
        "notes": "",
    },
]


COMMON_ENV = """\
> **Required env:** `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`  
> **Required pip:** `httpx`  
> **Install only if** this EvoClaw has OAuth connection for `{provider_config_key}` in Cloud.ru console.
"""

SKILL_TMPL = """\
---
name: {name}
description: {description}
timeout_sec: 300
required_pip:
  - httpx
required_env:
  - NANGO_PROXY_URL
  - EVOLUTION_PROJECT_ID
  - EVOCLAW_ID
  - CLOUDRU_API_KEY
allowed-tools: Fetch HTTP
metadata:
  openclaw:
    requires:
      env:
        - NANGO_PROXY_URL
        - EVOLUTION_PROJECT_ID
        - EVOCLAW_ID
        - CLOUDRU_API_KEY
    primaryEnv: CLOUDRU_API_KEY
  nango:
    family: {family}
    provider_config_key: {provider_config_key}
---

{common_env}

## What this skill does

**{title}** — authenticated HTTP via **ai-assistant-nango-proxy** → Nango → provider API.

- Nango `provider_config_key`: **`{provider_config_key}`**
- Scopes / access: `{scopes}`
- Upstream base (via Nango): `{base}`
{aliases_block}
OpenClaw never sees OAuth tokens or the Nango secret.

## When to use

{when}

Do **not** use for other vendors — install the matching skill (`yandex-*`, `bitrix24-*`, `amocrm-*`).

## Prerequisites

1. User completed OAuth for **`{provider_config_key}`** on this EvoClaw in Cloud.ru console.
2. Env injected (operator / pod): `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`.
3. `pip install httpx` once per session if needed.

Connection end-user id:

```text
project-{{EVOLUTION_PROJECT_ID}}-evoclaw-{{EVOCLAW_ID}}
```

## CLI

```bash
{examples_block}
```

Flags: `--method`, `--json`, `--body-file`, `--query`, `--header`, `--timeout`, `--project-id`, `--evoclaw-id`, `--api-key`, `--proxy-url`, `--json-output`.

## Agent workflow

1. Confirm the request matches **{title}** (`{provider_config_key}`).
2. Prefer `python3 __BASEDIR__/scripts/nango_proxy.py call {provider_config_key} …`.
3. On **401** — API key / IAM; do not invent alternate auth.
4. On **404** — wrong `EVOCLAW_ID`.
5. On upstream **4xx/5xx** — missing/expired OAuth → ask user to reconnect **{provider_config_key}** in console.
6. Never log `CLOUDRU_API_KEY` or tokens.

{notes_block}

## References

- `__BASEDIR__/references/endpoints.md` — endpoints for this skill
- `__BASEDIR__/references/api-reference.md` — proxy contract
"""


def brace_escape(value: str) -> str:
    return value.replace("{", "{{").replace("}", "}}")


def render_skill(entry: dict) -> str:
    aliases = entry.get("aliases") or []
    aliases_block = ""
    if aliases:
        joined = ", ".join(f"`{a}`" for a in aliases)
        aliases_block = f"- Also accepted unique key(s): {joined}\n"

    examples_block = "\n".join(
        f"# {title}\npython3 __BASEDIR__/scripts/nango_proxy.py {brace_escape(cmd)}"
        for title, cmd in entry["examples"]
    )

    notes = (entry.get("notes") or "").strip()
    notes_block = f"## Notes\n\n{brace_escape(notes)}\n" if notes else ""

    text = SKILL_TMPL.format(
        name=entry["name"],
        description=brace_escape(entry["description"]),
        family=entry["family"],
        provider_config_key=entry["provider_config_key"],
        title=brace_escape(entry["title"]),
        scopes=brace_escape(entry["scopes"]),
        base=brace_escape(entry["base"]),
        when=brace_escape(entry["when"]),
        common_env=COMMON_ENV.format(provider_config_key=entry["provider_config_key"]),
        aliases_block=aliases_block,
        examples_block=examples_block,
        notes_block=notes_block,
    )
    return text.replace("__BASEDIR__", "{baseDir}")


def render_endpoints(entry: dict) -> str:
    lines = [
        f"# {entry['title']}",
        "",
        f"- **Skill id:** `{entry['id']}`",
        f"- **Nango provider_config_key:** `{entry['provider_config_key']}`",
        f"- **Family:** `{entry['family']}`",
        f"- **Scopes:** {entry['scopes']}",
        f"- **Upstream base:** `{entry['base']}`",
        "",
        "## Examples",
        "",
    ]
    for title, cmd in entry["examples"]:
        lines.append(f"### {title}")
        lines.append("")
        lines.append("```bash")
        lines.append(f"python3 scripts/nango_proxy.py {cmd}")
        lines.append("```")
        lines.append("")
    notes = (entry.get("notes") or "").strip()
    if notes:
        lines.extend(["## Notes", "", notes, ""])
    return "\n".join(lines)


def main() -> None:
    if SKILLS.exists():
        for child in SKILLS.iterdir():
            if child.is_dir():
                shutil.rmtree(child)

    for entry in CATALOG:
        dest = SKILLS / entry["id"]
        (dest / "scripts").mkdir(parents=True)
        (dest / "references").mkdir(parents=True)
        (dest / "SKILL.md").write_text(render_skill(entry), encoding="utf-8")
        (dest / "references" / "endpoints.md").write_text(
            render_endpoints(entry), encoding="utf-8"
        )
        shutil.copy2(SHARED / "scripts" / "nango_proxy.py", dest / "scripts" / "nango_proxy.py")
        shutil.copy2(
            SHARED / "references" / "api-reference.md",
            dest / "references" / "api-reference.md",
        )
        print(f"generated {entry['id']}")

    # catalog.md
    by_family: dict[str, list[dict]] = {}
    for e in CATALOG:
        by_family.setdefault(e["family"], []).append(e)

    lines = [
        "# Skills catalog",
        "",
        "Install **only** the skills that match OAuth integrations connected for the EvoClaw.",
        "",
        "| Skill dir | Nango `provider_config_key` | Family | When |",
        "| --- | --- | --- | --- |",
    ]
    for e in CATALOG:
        when = e["when"].replace("|", "/")
        lines.append(
            f"| `skills/{e['id']}/` | `{e['provider_config_key']}` | {e['family']} | {when} |"
        )
    lines.extend(["", "## By family", ""])
    for family, items in by_family.items():
        lines.append(f"### {family}")
        lines.append("")
        for e in items:
            lines.append(f"- `{e['id']}` → `{e['provider_config_key']}` — {e['title']}")
        lines.append("")
    (ROOT / "CATALOG.md").write_text("\n".join(lines), encoding="utf-8")
    print("wrote CATALOG.md")


if __name__ == "__main__":
    main()
