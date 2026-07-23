#!/usr/bin/env python3
"""Generate the deterministic OpenClaw skill catalog and packages."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import stat
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qsl


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "catalog" / "skills.json"
SHARED = ROOT / "_shared"
SKILLS = ROOT / "skills"

EXPECTED_SKILL_IDS = (
    "yandex-id",
    "yandex-disk",
    "yandex-mail",
    "yandex-calendar",
    "yandex-direct",
    "yandex-maps",
    "yandex-market",
    "yandex-delivery",
    "bitrix24",
    "bitrix24-crm",
    "bitrix24-tasks",
    "bitrix24-disk",
    "bitrix24-im",
    "bitrix24-user",
    "bitrix24-calendar",
    "bitrix24-bizproc",
    "bitrix24-telephony",
    "amocrm",
    "amocrm-crm",
    "amocrm-catalog",
    "amocrm-chats",
    "amocrm-telephony",
    "amocrm-tasks",
    "amocrm-events",
    "amocrm-users",
)
EXPECTED_SKILL_COUNT = len(EXPECTED_SKILL_IDS)
GENERATED_PACKAGE_FILES = (
    "SKILL.md",
    "references/api-reference.md",
    "references/endpoints.md",
    "scripts/nango_proxy.py",
)
TEXT_FILE_MODE = 0o644
EXECUTABLE_FILE_MODE = 0o755
CATALOG_FILE_MODE = TEXT_FILE_MODE
GENERATED_PACKAGE_MODES = {
    "SKILL.md": TEXT_FILE_MODE,
    "references/api-reference.md": TEXT_FILE_MODE,
    "references/endpoints.md": TEXT_FILE_MODE,
    "scripts/nango_proxy.py": EXECUTABLE_FILE_MODE,
}
REQUIRED_ENV = (
    "NANGO_PROXY_URL",
    "EVOLUTION_PROJECT_ID",
    "EVOCLAW_ID",
    "CLOUDRU_API_KEY",
)

PAGINATION_MODES = {
    "yandex-disk": "offset",
    "yandex-calendar": "single",
    "yandex-direct": "body-offset",
    "yandex-market": "offset",
    "bitrix24-crm": "offset",
    "bitrix24-tasks": "offset",
    "bitrix24-disk": "offset",
    "bitrix24-im": "offset",
    "bitrix24-user": "offset",
    "bitrix24-calendar": "offset",
    "bitrix24-bizproc": "offset",
    "bitrix24-telephony": "offset",
    "amocrm-crm": "link",
    "amocrm-catalog": "link",
    "amocrm-chats": "link",
    "amocrm-telephony": "link",
    "amocrm-tasks": "link",
    "amocrm-events": "link",
    "amocrm-users": "link",
}
PREFERRED_OPERATION_INDEX = {
    "yandex-disk": 1,
}


def _trigger_phrase(entry):
    value = entry["when"].strip().rstrip(".")
    for prefix in ("User asks about ", "User asks to ", "User asks "):
        if value.startswith(prefix):
            return value[len(prefix) :]
    return value


def _request_from_command(command):
    """Convert a catalog fallback command into a typed plugin example."""
    arguments = shlex.split(command)
    request = {
        "providerConfigKey": arguments[1],
        "method": "GET",
        "path": arguments[2],
    }
    index = 3
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--method":
            request["method"] = arguments[index + 1].upper()
            index += 2
        elif argument == "--query":
            request["query"] = [
                {"name": name, "value": value}
                for name, value in parse_qsl(
                    arguments[index + 1], keep_blank_values=True
                )
            ]
            index += 2
        elif argument == "--json":
            request["jsonBody"] = json.loads(arguments[index + 1])
            index += 2
        elif argument == "--json-output":
            index += 1
        else:
            # The catalog validator owns the complete fallback grammar. Avoid
            # fabricating a typed example for a flag the plugin does not expose.
            return None
    return request


def _json_lines(value):
    return json.dumps(value, ensure_ascii=False, indent=2).splitlines()


def _generic_plugin_example(entry):
    if entry["id"] in {
        "yandex-maps",
        "yandex-mail",
        "yandex-calendar",
        "yandex-delivery",
    }:
        return []

    operation_index = PREFERRED_OPERATION_INDEX.get(entry["id"], 0)
    request = _request_from_command(
        entry["operations"][operation_index]["command"]
    )
    if request is None:
        return []
    if entry["id"] == "yandex-direct":
        request["jsonBody"]["params"]["Page"] = {
            "Limit": 100,
            "Offset": 0,
        }
    mode = PAGINATION_MODES.get(entry["id"])
    tool = "nango_proxy_paginate" if mode else "nango_proxy_request"
    if mode:
        request.update({"mode": mode, "maxPages": 10, "maxItems": 500})

    return [
        "### Preferred call",
        "",
        "Use `{}` with:".format(tool),
        "",
        "```json",
        *_json_lines(request),
        "```",
        "",
    ]


def _special_guidance(entry):
    skill_id = entry["id"]
    if skill_id == "yandex-disk":
        return [
            "### Disk-specific calls",
            "",
            "Use `nango_proxy_paginate` for bounded metadata listings. Use "
            "`nango_disk_transfer` for file bytes:",
            "",
            "```json",
            *_json_lines(
                {
                    "providerConfigKey": "yandex-disk",
                    "direction": "upload",
                    "localPath": "/allowed/root/report.csv",
                    "remotePath": "disk:/report.csv",
                    "overwrite": False,
                }
            ),
            "```",
            "",
            "Upload and download are mutations because they write either remote "
            "or local state. After upload, read `v1/disk/resources` for the "
            "remote path and compare metadata.",
            "",
        ]
    if skill_id == "yandex-mail":
        return [
            "### Mail actions",
            "",
            "Use `nango_action` only with these registered actions:",
            "",
            "- `resolve-mailbox`",
            "- `list-messages`",
            "- `get-message`",
            "- `send-message`",
            "",
            "Example bounded read:",
            "",
            "```json",
            *_json_lines(
                {
                    "providerConfigKey": "yandex-mail",
                    "actionName": "list-messages",
                    "input": {"folder": "INBOX", "limit": 25},
                }
            ),
            "```",
            "",
            "For `send-message`, pass recipients, body, optional inline base64 "
            "attachments, and a stable `idempotencyKey` inside `input`.",
            "",
            "The action reaches the fixed Yandex IMAP/SMTP bridge. Do not extract "
            "or expose the OAuth token, and do not attempt IMAP or SMTP through "
            "`nango_proxy_request`. A confirmed send returns a Message-ID; an "
            "`unknown` send must be checked in mailbox state before another key "
            "is used.",
            "",
        ]
    if skill_id == "yandex-calendar":
        return [
            "### CalDAV contract",
            "",
            "This is CalDAV, not a JSON calendar API. Use `PROPFIND` for "
            "discovery and `REPORT` for bounded event queries; send XML with an "
            "explicit XML content type. Example discovery through "
            "`nango_proxy_paginate`:",
            "",
            "```json",
            *_json_lines(
                {
                    "providerConfigKey": "yandex-calendar",
                    "method": "PROPFIND",
                    "path": "calendars/",
                    "headers": {"Depth": "1"},
                    "textBody": (
                        '<?xml version="1.0" encoding="utf-8"?>'
                        '<d:propfind xmlns:d="DAV:"><d:prop>'
                        "<d:displayname/></d:prop></d:propfind>"
                    ),
                    "contentType": "application/xml; charset=utf-8",
                    "mode": "single",
                    "maxPages": 1,
                    "maxItems": 500,
                }
            ),
            "```",
            "",
            "Creating or changing an `.ics` resource "
            "uses a mutating request and must be verified by reading its URL and "
            "ETag.",
            "",
        ]
    if skill_id == "yandex-direct":
        return [
            "### JSON-RPC semantics",
            "",
            "Yandex Direct reads use HTTP `POST`. A body with "
            '`"method": "get"` on `json/v5/<service>` is a semantic read; other '
            "methods are mutations and require approval. For bounded listing, "
            "use `nango_proxy_paginate` with `body-offset` and preserve the "
            "request's `Page.Limit`.",
            "",
        ]
    if skill_id == "yandex-maps":
        return [
            "### Unsupported endpoint boundary",
            "",
            "No public bookmarks endpoint is confirmed for the declared scope. "
            "Do not invent `v1/`, a host, or a response schema. Do not call "
            "`nango_proxy_request` until the operator supplies a documented "
            "endpoint for the connected Maps product; otherwise report the "
            "capability as unsupported.",
            "",
        ]
    if skill_id == "yandex-market":
        return [
            "### Authentication caveat",
            "",
            "The repository has not live-tested this OAuth connection against "
            "the current Partner API. Use only the connection configured for "
            "`yandex-market`; report provider authorization errors without "
            "claiming that OAuth or Api-Key is universally required.",
            "",
        ]
    if skill_id == "yandex-delivery":
        return [
            "### Product-contract boundary",
            "",
            "`api/b2b/platform/offers/create` is a mutation, not a probe. Never "
            "use an empty create request as a health probe. Require the exact "
            "Delivery API product schema and real required fields before calling "
            "`nango_proxy_request`; after success, fetch the created entity. On "
            "an uncertain dispatch, inspect provider state before retrying.",
            "",
        ]
    if skill_id == "amocrm-chats":
        return [
            "### Chats action",
            "",
            "Use `nango_proxy_paginate` for read-only `api/v4/talks`. Use "
            "`nango_action` with the registered `send-message` action for "
            "outbound chat messages; follow the exposed input schema rather than "
            "inventing amoJo fields:",
            "",
            "```json",
            *_json_lines(
                {
                    "providerConfigKey": "amocrm-chats",
                    "actionName": "send-message",
                    "input": {
                        "conversationId": "<confirmed-conversation-id>",
                        "message": {"type": "text", "text": "Hello"},
                        "idempotencyKey": "<stable-key>",
                    },
                }
            ),
            "```",
            "",
            "Sending is a mutation. Confirm the returned "
            "message id, or inspect chat state if the outcome is `unknown`.",
            "",
        ]
    return []


def load_catalog(path=CATALOG_PATH):
    """Load and validate the ordered catalog source."""
    document = json.loads(path.read_text(encoding="utf-8"))
    if document.get("schema_version") != 1:
        raise ValueError("catalog schema_version must be 1")

    entries = document.get("skills")
    if not isinstance(entries, list) or len(entries) != EXPECTED_SKILL_COUNT:
        raise ValueError("catalog must contain exactly 25 skills")

    required = {
        "id",
        "name",
        "title",
        "family",
        "provider_config_key",
        "description",
        "when",
        "scopes",
        "base",
        "notes",
        "operations",
    }
    ids = []
    provider_keys = []
    aliases = []
    for entry in entries:
        if not isinstance(entry, dict):
            raise ValueError("each catalog skill must be an object")
        missing = required - set(entry)
        if missing:
            raise ValueError(
                "{} is missing catalog fields: {}".format(
                    entry.get("id", "<unknown>"), ", ".join(sorted(missing))
                )
            )

        skill_id = entry["id"]
        provider_key = entry["provider_config_key"]
        if skill_id != provider_key or entry["name"] != skill_id:
            raise ValueError(
                "{} must use the same id, name and provider_config_key".format(
                    skill_id
                )
            )
        ids.append(skill_id)
        provider_keys.append(provider_key)

        declared_aliases = entry.get("aliases", [])
        if not isinstance(declared_aliases, list):
            raise ValueError("{} aliases must be a list".format(skill_id))
        aliases.extend((alias, skill_id) for alias in declared_aliases)

        operations = entry["operations"]
        if not isinstance(operations, list) or not operations:
            raise ValueError("{} must declare at least one operation".format(skill_id))
        allowed_providers = {provider_key, *declared_aliases}
        for operation in operations:
            if set(operation) != {"title", "command"}:
                raise ValueError(
                    "{} operations require only title and command".format(skill_id)
                )
            command = shlex.split(operation["command"])
            if len(command) < 3 or command[0] != "call":
                raise ValueError("{} operation is not a call command".format(skill_id))
            if command[1] not in allowed_providers:
                raise ValueError(
                    "{} operation uses undeclared provider {}".format(
                        skill_id, command[1]
                    )
                )
            for index, argument in enumerate(command):
                if argument == "--json":
                    if index + 1 == len(command):
                        raise ValueError(
                            "{} operation has no --json value".format(skill_id)
                        )
                    json.loads(command[index + 1])

    if tuple(ids) != EXPECTED_SKILL_IDS:
        raise ValueError("catalog must contain the exact ordered skill ids")
    if tuple(provider_keys) != EXPECTED_SKILL_IDS:
        raise ValueError(
            "catalog must contain the exact ordered provider_config_key values"
        )
    if aliases != [("yandex", "yandex-id")]:
        raise ValueError("only yandex-id may declare the legacy yandex alias")
    return entries


def render_skill(entry):
    aliases = entry.get("aliases", [])
    description = json.dumps(
        "{} tasks: {}.".format(entry["title"], _trigger_phrase(entry)),
        ensure_ascii=False,
    )
    metadata = json.dumps(
        {
            "openclaw": {},
            "nango": {
                "family": entry["family"],
                "provider_config_key": entry["provider_config_key"],
            },
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    lines = [
        "---",
        "name: {}".format(entry["name"]),
        "description: {}".format(description),
        "metadata: {}".format(metadata),
        "---",
        "",
        "# {}".format(entry["title"]),
        "",
        "Use this skill when the user requests {} through the configured "
        "Nango connection.".format(
            _trigger_phrase(entry)
        ),
        "",
        "- Route only to `providerConfigKey`: **`{}`**.".format(
            entry["provider_config_key"]
        ),
        "- Scopes / access: `{}`".format(entry["scopes"]),
        "- Upstream base (via Nango): `{}`".format(entry["base"]),
    ]
    if aliases:
        lines.append(
            "- Also accepted unique key(s): {}".format(
                ", ".join("`{}`".format(alias) for alias in aliases)
            )
        )
    lines.extend(
        [
            "",
            "## Workflow",
            "",
            "1. Use the exact provider key above; never route by a similar "
            "vendor name.",
            "2. Use `nango_proxy_request` for one provider request and "
            "`nango_proxy_paginate` only for a registered bounded read contract.",
            "3. Use `nango_action` only for a registered action and "
            "`nango_disk_transfer` only for Yandex Disk file transfer.",
            "4. Reads run without a prompt. Every semantic mutation requires "
            "one-time approval tied to the exact tool call and parameters.",
            "5. Treat `confirmed` as completed, `not_started` as safe to fix and "
            "retry, and `confirmed_failed` as a provider-confirmed failure. "
            "For `unknown`, inspect provider state and do not retry blindly.",
            "6. Do not infer the failing layer from HTTP status alone. Return the "
            "tool's safe error code and outcome; never expose credentials.",
            "",
            "Do not use the Python fallback to bypass approval.",
            "",
            "## Typed tools",
            "",
        ]
    )
    lines.extend(_generic_plugin_example(entry))
    lines.extend(_special_guidance(entry))
    lines.extend(
        [
            "Request inputs are strict: relative `path`, ordered `query` pairs, "
            "bounded headers/body, and no caller-supplied auth, raw Nango control "
            "headers, approval proof, or operation classification fields.",
            "",
            "## Operator-only fallback",
            "",
            "Keep this compatibility path for diagnostics or deployments where "
            "the plugin is unavailable. It requires `NANGO_PROXY_URL`, "
            "`EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`, Python 3, "
            "and `httpx`. An operator must explicitly choose it. Mutations still "
            "need approval and post-write verification.",
            "",
            "```bash",
        ]
    )
    for operation in entry["operations"]:
        lines.extend(
            [
                "# {}".format(operation["title"]),
                "python3 {{baseDir}}/scripts/nango_proxy.py {}".format(
                    operation["command"]
                ),
            ]
        )
    lines.extend(
        [
            "```",
            "",
            "The fallback preserves the full generic HTTP flags documented in "
            "`{baseDir}/references/api-reference.md`.",
            "",
        ]
    )
    notes = entry["notes"].strip()
    if notes:
        lines.extend(["## Notes", "", notes, ""])
    lines.extend(
        [
            "## References",
            "",
            (
                "- `{baseDir}/references/endpoints.md` — endpoints for this skill"
            ),
            (
                "- `{baseDir}/references/api-reference.md` — proxy contract"
            ),
            "",
        ]
    )
    return "\n".join(lines)


def render_endpoints(entry):
    lines = [
        "# {}".format(entry["title"]),
        "",
        "- **Skill id:** `{}`".format(entry["id"]),
        "- **Nango provider_config_key:** `{}`".format(
            entry["provider_config_key"]
        ),
        "- **Family:** `{}`".format(entry["family"]),
        "- **Scopes:** {}".format(entry["scopes"]),
        "- **Upstream base:** `{}`".format(entry["base"]),
        "",
        "## Examples",
        "",
    ]
    for operation in entry["operations"]:
        lines.extend(
            [
                "### {}".format(operation["title"]),
                "",
                "```bash",
                "python3 {{baseDir}}/scripts/nango_proxy.py {}".format(
                    operation["command"]
                ),
                "```",
                "",
            ]
        )
    notes = entry["notes"].strip()
    if notes:
        lines.extend(["## Notes", "", notes, ""])
    return "\n".join(lines)


def render_catalog(entries):
    by_family = {}
    for entry in entries:
        by_family.setdefault(entry["family"], []).append(entry)

    lines = [
        "# Skills catalog",
        "",
        (
            "Install **only** the skills that match OAuth integrations "
            "connected for the EvoClaw."
        ),
        "",
        "| Skill dir | Nango `provider_config_key` | Family | When |",
        "| --- | --- | --- | --- |",
    ]
    for entry in entries:
        lines.append(
            "| `skills/{}/` | `{}` | {} | {} |".format(
                entry["id"],
                entry["provider_config_key"],
                entry["family"],
                entry["when"].replace("|", "/"),
            )
        )
    lines.extend(["", "## By family", ""])
    for family, family_entries in by_family.items():
        lines.extend(["### {}".format(family), ""])
        for entry in family_entries:
            lines.append(
                "- `{}` → `{}` — {}".format(
                    entry["id"], entry["provider_config_key"], entry["title"]
                )
            )
        lines.append("")
    return "\n".join(lines)


def _write_text(path, content):
    path.write_text(content, encoding="utf-8")
    path.chmod(TEXT_FILE_MODE)


def render_tree(stage_root, entries):
    canonical_proxy = SHARED / "scripts" / "nango_proxy.py"
    canonical_reference = SHARED / "references" / "api-reference.md"
    if not canonical_proxy.is_file() or not canonical_reference.is_file():
        raise FileNotFoundError("canonical shared assets are missing")

    for entry in entries:
        destination = stage_root / "skills" / entry["id"]
        (destination / "scripts").mkdir(parents=True)
        (destination / "references").mkdir(parents=True)
        _write_text(
            destination / "SKILL.md",
            render_skill(entry),
        )
        _write_text(
            destination / "references" / "endpoints.md",
            render_endpoints(entry),
        )
        shutil.copy2(
            canonical_proxy, destination / "scripts" / "nango_proxy.py"
        )
        (destination / "scripts" / "nango_proxy.py").chmod(
            EXECUTABLE_FILE_MODE
        )
        shutil.copy2(
            canonical_reference,
            destination / "references" / "api-reference.md",
        )
        (destination / "references" / "api-reference.md").chmod(
            TEXT_FILE_MODE
        )
    _write_text(
        stage_root / "CATALOG.md",
        render_catalog(entries),
    )


def _collect_managed_entries(root):
    entries = {}
    catalog = root / "CATALOG.md"
    if catalog.is_symlink():
        entries["CATALOG.md"] = ("symlink", os.readlink(str(catalog)))
    elif catalog.is_file():
        entries["CATALOG.md"] = (
            "file",
            stat.S_IMODE(catalog.stat().st_mode),
            catalog.read_bytes(),
        )
    elif catalog.exists():
        entries["CATALOG.md"] = ("other",)

    skills = root / "skills"
    if not skills.is_dir():
        return entries
    for path in sorted(skills.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            entries[relative] = ("symlink", os.readlink(str(path)))
        elif path.is_dir():
            entries[relative] = ("directory",)
        elif path.is_file():
            entries[relative] = (
                "file",
                stat.S_IMODE(path.stat().st_mode),
                path.read_bytes(),
            )
        else:
            entries[relative] = ("other",)
    return entries


def compare_trees(expected_root, actual_root):
    expected = _collect_managed_entries(expected_root)
    actual = _collect_managed_entries(actual_root)
    missing = sorted(set(expected) - set(actual))
    extra = sorted(set(actual) - set(expected))
    stale = sorted(
        path
        for path in set(expected) & set(actual)
        if expected[path] != actual[path]
    )
    return missing, extra, stale


def _same_file(source, destination):
    if destination.is_symlink() or not destination.is_file():
        return False
    source_mode = stat.S_IMODE(source.stat().st_mode)
    destination_mode = stat.S_IMODE(destination.stat().st_mode)
    return (
        source_mode == destination_mode
        and source.read_bytes() == destination.read_bytes()
    )


def _validate_destination(destination_root, destination):
    relative = destination.relative_to(destination_root)
    current = destination_root
    for part in relative.parts[:-1]:
        current = current / part
        if current.is_symlink():
            raise OSError(
                "refusing symlinked generated path {}".format(current)
            )
        if current.exists() and not current.is_dir():
            raise NotADirectoryError(
                "generated parent is not a directory: {}".format(current)
            )
    if destination.is_symlink():
        raise OSError(
            "refusing symlinked generated path {}".format(destination)
        )
    if destination.exists() and not destination.is_file():
        raise IsADirectoryError(
            "refusing to replace non-file {}".format(destination)
        )


def _replace_file(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if _same_file(source, destination):
        return

    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".{}.".format(destination.name),
        suffix=".tmp",
        dir=str(destination.parent),
    )
    os.close(descriptor)
    temporary = Path(temporary_name)
    try:
        shutil.copy2(source, temporary)
        os.replace(str(temporary), str(destination))
    finally:
        if temporary.exists():
            temporary.unlink()


def install_generated_files(stage_root, destination_root, entries):
    relative_files = ["CATALOG.md"]
    for entry in entries:
        for relative in GENERATED_PACKAGE_FILES:
            relative_files.append("skills/{}/{}".format(entry["id"], relative))
    for relative in relative_files:
        _validate_destination(destination_root, destination_root / relative)
    for relative in relative_files:
        _replace_file(stage_root / relative, destination_root / relative)


def run(check=False):
    entries = load_catalog()
    with tempfile.TemporaryDirectory(prefix="openclaw-skill-generation-") as name:
        stage_root = Path(name)
        render_tree(stage_root, entries)
        if check:
            missing, extra, stale = compare_trees(stage_root, ROOT)
            if missing or extra or stale:
                for path in missing:
                    print("missing: {}".format(path), file=sys.stderr)
                for path in extra:
                    print("extra: {}".format(path), file=sys.stderr)
                for path in stale:
                    print("stale: {}".format(path), file=sys.stderr)
                return 1
            print("generated files are up to date")
            return 0

        install_generated_files(stage_root, ROOT, entries)
        for entry in entries:
            print("generated {}".format(entry["id"]))
        print("wrote CATALOG.md")
        return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="report generated drift without modifying the repository",
    )
    arguments = parser.parse_args(argv)
    try:
        return run(check=arguments.check)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print("generation failed: {}".format(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
