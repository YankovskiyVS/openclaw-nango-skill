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
OPERATION_REQUIRED_FIELDS = {
    "title",
    "availability",
    "tool",
    "method",
    "path",
    "pagination",
    "operation_kind",
    "verification",
    "docs",
}
OPERATION_OPTIONAL_FIELDS = {
    "command",
    "provider_config_key",
    "fallback_contract",
    "query",
    "headers",
    "json_body",
    "text_body",
    "content_type",
    "action_name",
    "action_input",
    "transfer",
}
OPERATION_AVAILABILITY = {
    "ready",
    "template",
    "unsupported",
    "blocked_contract",
}
TYPED_TOOLS = {
    "nango_proxy_request",
    "nango_proxy_paginate",
    "nango_action",
    "nango_disk_transfer",
}
PROXY_TOOLS = {
    "nango_proxy_request",
    "nango_proxy_paginate",
}
REGISTERED_ACTION_KINDS = {
    ("yandex-mail", "resolve-mailbox"): "read",
    ("yandex-mail", "list-messages"): "read",
    ("yandex-mail", "get-message"): "read",
    ("yandex-mail", "send-message"): "mutation",
    ("amocrm-chats", "send-message"): "mutation",
}
RECORDED_AUTHORITATIVE_DOC_URLS = {
    "https://yandex.com/dev/disk/api/concepts/about.html",
}
HTTP_METHODS = {
    "GET",
    "HEAD",
    "OPTIONS",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "PROPFIND",
    "REPORT",
}
PAGINATION_SOURCE_MODES = {
    "none",
    "single",
    "offset",
    "body-offset",
    "link",
    "action-window",
}
FALLBACK_REQUIRED_FIELDS = {
    "transport",
    "operation_kind",
    "provider_config_key",
    "method",
    "path",
}
FALLBACK_OPTIONAL_FIELDS = {
    "query",
    "headers",
    "json_body",
    "text_body",
    "content_type",
}

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


def _validate_string(value, label, skill_id):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("{} {} must be a non-empty string".format(skill_id, label))


def _validate_pagination(skill_id, operation):
    pagination = operation["pagination"]
    if not isinstance(pagination, dict):
        raise ValueError("{} operation pagination must be an object".format(skill_id))
    mode = pagination.get("mode")
    if mode not in PAGINATION_SOURCE_MODES:
        raise ValueError(
            "{} operation has unsupported pagination mode".format(skill_id)
        )
    if mode == "none":
        expected = {"mode"}
    elif mode == "action-window":
        expected = {
            "mode",
            "page_limit",
            "max_items",
            "continuation",
        }
        if (
            type(pagination.get("page_limit")) is not int
            or pagination["page_limit"] < 1
            or type(pagination.get("max_items")) is not int
            or pagination["max_items"] < 1
        ):
            raise ValueError(
                "{} action-window bounds must be positive integers".format(
                    skill_id
                )
            )
        _validate_string(
            pagination.get("continuation"),
            "pagination continuation",
            skill_id,
        )
    else:
        expected = {"mode", "max_pages", "max_items"}
        if (
            type(pagination.get("max_pages")) is not int
            or pagination["max_pages"] < 1
            or type(pagination.get("max_items")) is not int
            or pagination["max_items"] < 1
        ):
            raise ValueError(
                "{} pagination bounds must be positive integers".format(skill_id)
            )
    if set(pagination) != expected:
        raise ValueError(
            "{} pagination fields do not match mode {}".format(skill_id, mode)
        )
    return mode


def _validate_docs(skill_id, operation):
    docs = operation["docs"]
    if not isinstance(docs, dict) or set(docs) != {"status", "url"}:
        raise ValueError(
            "{} operation docs require only status and url".format(skill_id)
        )
    if docs["status"] == "verified":
        if not isinstance(docs["url"], str) or not docs["url"].startswith(
            "https://"
        ):
            raise ValueError(
                "{} verified docs require an https URL".format(skill_id)
            )
        if docs["url"] not in RECORDED_AUTHORITATIVE_DOC_URLS:
            raise ValueError(
                "{} verified docs URL is not recorded in the repository".format(
                    skill_id
                )
            )
    elif docs["status"] == "not_verified":
        if docs["url"] is not None:
            raise ValueError(
                "{} not_verified docs must use a null URL".format(skill_id)
            )
    else:
        raise ValueError(
            "{} operation docs status must be verified or not_verified".format(
                skill_id
            )
        )


def _validate_query(skill_id, query):
    if not isinstance(query, list):
        raise ValueError("{} operation query must be a list".format(skill_id))
    for pair in query:
        if (
            not isinstance(pair, dict)
            or set(pair) != {"name", "value"}
            or not isinstance(pair["name"], str)
            or not pair["name"]
            or not isinstance(pair["value"], str)
        ):
            raise ValueError(
                "{} operation query requires string name/value pairs".format(
                    skill_id
                )
            )


def _validate_headers(skill_id, headers, label):
    if not isinstance(headers, dict) or not all(
        isinstance(name, str)
        and name
        and isinstance(value, str)
        for name, value in headers.items()
    ):
        raise ValueError(
            "{} {} headers must be string pairs".format(skill_id, label)
        )


def _validate_body_fields(skill_id, contract, label):
    if "text_body" in contract and not isinstance(
        contract["text_body"], str
    ):
        raise ValueError(
            "{} {} text_body must be a string".format(skill_id, label)
        )
    if "content_type" in contract:
        _validate_string(
            contract["content_type"],
            "{} content_type".format(label),
            skill_id,
        )
        if "text_body" not in contract:
            raise ValueError(
                "{} {} content_type requires text_body".format(skill_id, label)
            )
    if "json_body" in contract and "text_body" in contract:
        raise ValueError(
            "{} {} cannot mix json_body and text_body".format(skill_id, label)
        )


def _validate_fallback_contract(skill_id, contract, allowed_providers):
    if not isinstance(contract, dict):
        raise ValueError(
            "{} fallback_contract must be an object".format(skill_id)
        )
    missing = FALLBACK_REQUIRED_FIELDS - set(contract)
    unknown = set(contract) - FALLBACK_REQUIRED_FIELDS - FALLBACK_OPTIONAL_FIELDS
    if missing:
        raise ValueError(
            "{} fallback_contract is missing fields: {}".format(
                skill_id,
                ", ".join(sorted(missing)),
            )
        )
    if unknown:
        raise ValueError(
            "{} fallback_contract has unsupported fields: {}".format(
                skill_id,
                ", ".join(sorted(unknown)),
            )
        )
    if contract["transport"] != "proxy_http":
        raise ValueError(
            "{} fallback_contract has unsupported transport".format(skill_id)
        )
    if contract["operation_kind"] not in {"read", "mutation"}:
        raise ValueError(
            "{} fallback_contract has unsupported operation_kind".format(
                skill_id
            )
        )
    if contract["provider_config_key"] not in allowed_providers:
        raise ValueError(
            "{} fallback_contract uses undeclared provider {}".format(
                skill_id,
                contract["provider_config_key"],
            )
        )
    if contract["method"] not in HTTP_METHODS:
        raise ValueError(
            "{} fallback_contract requires a supported method".format(skill_id)
        )
    _validate_string(
        contract["path"],
        "fallback_contract path",
        skill_id,
    )
    if "query" in contract:
        _validate_query(skill_id, contract["query"])
    if "headers" in contract:
        _validate_headers(skill_id, contract["headers"], "fallback_contract")
    _validate_body_fields(skill_id, contract, "fallback_contract")


def _normalized_http_contract(
    provider_config_key,
    source,
):
    contract = {
        "provider_config_key": provider_config_key,
        "method": source["method"],
        "path": source["path"],
        "query": source.get("query", []),
        "headers": source.get("headers", {}),
    }
    for field in ("json_body", "text_body", "content_type"):
        if field in source:
            contract[field] = source[field]
    return contract


def _command_http_contract(skill_id, command_text):
    try:
        command = shlex.split(command_text)
    except ValueError as exc:
        raise ValueError(
            "{} operation command has invalid shell syntax".format(skill_id)
        ) from exc
    if len(command) < 3 or command[0] != "call":
        raise ValueError("{} operation is not a call command".format(skill_id))

    contract = {
        "provider_config_key": command[1],
        "method": "GET",
        "path": command[2],
        "query": [],
        "headers": {},
    }
    body_mode = None
    content_type = None
    json_output = False
    index = 3
    while index < len(command):
        argument = command[index]
        if argument == "--json-output":
            if json_output:
                raise ValueError(
                    "{} operation repeats --json-output".format(skill_id)
                )
            json_output = True
            index += 1
            continue
        if argument not in {
            "--method",
            "--query",
            "--header",
            "--json",
            "--text",
        }:
            raise ValueError(
                "{} operation command uses unsupported catalog flag {}".format(
                    skill_id,
                    argument,
                )
            )
        if index + 1 == len(command):
            raise ValueError(
                "{} operation command has no value for {}".format(
                    skill_id,
                    argument,
                )
            )
        value = command[index + 1]
        index += 2

        if argument == "--method":
            contract["method"] = value.upper()
        elif argument == "--query":
            contract["query"] = [
                {"name": name, "value": pair_value}
                for name, pair_value in parse_qsl(
                    value,
                    keep_blank_values=True,
                )
            ]
        elif argument == "--header":
            if ":" not in value:
                raise ValueError(
                    "{} operation command has an invalid header".format(
                        skill_id
                    )
                )
            name, header_value = value.split(":", 1)
            name = name.strip()
            header_value = header_value.strip()
            if name.lower() == "content-type":
                if content_type is not None:
                    raise ValueError(
                        "{} operation repeats Content-Type".format(skill_id)
                    )
                content_type = header_value
            else:
                normalized_names = {
                    existing.lower() for existing in contract["headers"]
                }
                if name.lower() in normalized_names:
                    raise ValueError(
                        "{} operation repeats a header".format(skill_id)
                    )
                contract["headers"][name] = header_value
        elif argument == "--json":
            if body_mode is not None:
                raise ValueError(
                    "{} operation command mixes body modes".format(skill_id)
                )
            body_mode = "json_body"
            try:
                contract["json_body"] = json.loads(value)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    "{} operation has invalid --json".format(skill_id)
                ) from exc
        elif argument == "--text":
            if body_mode is not None:
                raise ValueError(
                    "{} operation command mixes body modes".format(skill_id)
                )
            body_mode = "text_body"
            contract["text_body"] = value

    if not json_output:
        raise ValueError(
            "{} operation command must use --json-output".format(skill_id)
        )
    if content_type is not None:
        contract["content_type"] = content_type
    return contract


def _validate_operation(skill_id, operation, allowed_providers):
    if not isinstance(operation, dict):
        raise ValueError("{} operations must be objects".format(skill_id))
    missing = OPERATION_REQUIRED_FIELDS - set(operation)
    unknown = set(operation) - OPERATION_REQUIRED_FIELDS - OPERATION_OPTIONAL_FIELDS
    if missing:
        raise ValueError(
            "{} operation is missing fields: {}".format(
                skill_id, ", ".join(sorted(missing))
            )
        )
    if unknown:
        raise ValueError(
            "{} operation has unsupported fields: {}".format(
                skill_id, ", ".join(sorted(unknown))
            )
        )

    _validate_string(operation["title"], "operation title", skill_id)
    _validate_string(
        operation["verification"], "operation verification", skill_id
    )
    availability = operation["availability"]
    if availability not in OPERATION_AVAILABILITY:
        raise ValueError(
            "{} operation has unsupported availability".format(skill_id)
        )
    operation_kind = operation["operation_kind"]
    if operation_kind not in {"read", "mutation", "unsupported"}:
        raise ValueError(
            "{} operation has unsupported operation_kind".format(skill_id)
        )
    is_boundary = availability in {"unsupported", "blocked_contract"}
    if is_boundary != (operation_kind == "unsupported"):
        raise ValueError(
            "{} boundary availability and operation_kind must agree".format(
                skill_id
            )
        )

    operation_provider = operation.get("provider_config_key", skill_id)
    if operation_provider not in allowed_providers:
        raise ValueError(
            "{} operation uses undeclared provider {}".format(
                skill_id,
                operation_provider,
            )
        )

    tool = operation["tool"]
    if availability in {"ready", "template"}:
        if tool not in TYPED_TOOLS:
            raise ValueError(
                "{} executable/template operation requires a typed tool".format(
                    skill_id
                )
            )
    elif tool is not None:
        raise ValueError(
            "{} non-executable operation must not declare a tool".format(skill_id)
        )

    mode = _validate_pagination(skill_id, operation)
    _validate_docs(skill_id, operation)

    method = operation["method"]
    path = operation["path"]
    if tool in {"nango_proxy_request", "nango_proxy_paginate"}:
        if method not in HTTP_METHODS:
            raise ValueError(
                "{} proxy operation requires a supported method".format(skill_id)
            )
        _validate_string(path, "operation path", skill_id)
        if tool == "nango_proxy_request" and mode != "none":
            raise ValueError(
                "{} request operation cannot declare pagination".format(skill_id)
            )
        if tool == "nango_proxy_paginate" and mode not in {
            "single",
            "offset",
            "body-offset",
            "link",
        }:
            raise ValueError(
                "{} paginate operation requires a registered mode".format(skill_id)
            )
    elif tool in {"nango_action", "nango_disk_transfer"}:
        if method is not None or path is not None:
            raise ValueError(
                "{} action/transfer method and path must be null".format(skill_id)
            )
    else:
        if method is not None and method not in HTTP_METHODS:
            raise ValueError(
                "{} boundary method must be null or supported".format(skill_id)
            )
        if path is not None:
            _validate_string(path, "boundary path", skill_id)

    if "query" in operation:
        _validate_query(skill_id, operation["query"])
    if "headers" in operation:
        _validate_headers(skill_id, operation["headers"], "operation")
    _validate_body_fields(skill_id, operation, "operation")

    proxy_only = {
        "query",
        "headers",
        "json_body",
        "text_body",
        "content_type",
    }
    action_only = {"action_name", "action_input"}
    if tool in {"nango_proxy_request", "nango_proxy_paginate"}:
        if set(operation) & (action_only | {"transfer"}):
            raise ValueError(
                "{} proxy operation mixes typed surface fields".format(skill_id)
            )
    elif tool == "nango_action":
        if set(operation) & (proxy_only | {"transfer"}):
            raise ValueError(
                "{} action operation mixes typed surface fields".format(skill_id)
            )
        _validate_string(operation.get("action_name"), "action_name", skill_id)
        if not isinstance(operation.get("action_input"), dict):
            raise ValueError(
                "{} action operation requires an input object".format(skill_id)
            )
        expected_kind = REGISTERED_ACTION_KINDS.get(
            (skill_id, operation["action_name"])
        )
        if expected_kind is None or operation_kind != expected_kind:
            raise ValueError(
                "{} action is not registered with this operation_kind".format(
                    skill_id
                )
            )
        if mode not in {"none", "action-window"}:
            raise ValueError(
                "{} action operation has invalid pagination".format(skill_id)
            )
    elif tool == "nango_disk_transfer":
        if set(operation) & (proxy_only | action_only):
            raise ValueError(
                "{} transfer operation mixes typed surface fields".format(skill_id)
            )
        transfer = operation.get("transfer")
        if not isinstance(transfer, dict) or set(transfer) != {
            "direction",
            "localPath",
            "remotePath",
            "overwrite",
        }:
            raise ValueError(
                "{} transfer operation has an invalid request shape".format(skill_id)
            )
        if transfer["direction"] not in {"upload", "download"}:
            raise ValueError(
                "{} transfer direction must be upload or download".format(skill_id)
            )
        for field in ("localPath", "remotePath"):
            _validate_string(transfer[field], "transfer {}".format(field), skill_id)
        if type(transfer["overwrite"]) is not bool:
            raise ValueError(
                "{} transfer overwrite must be boolean".format(skill_id)
            )
        if mode != "none":
            raise ValueError(
                "{} transfer operation cannot paginate".format(skill_id)
            )
        if skill_id != "yandex-disk" or operation_kind != "mutation":
            raise ValueError(
                "{} transfer is not registered for this operation".format(
                    skill_id
                )
            )
    elif set(operation) & (proxy_only | action_only | {"transfer"}):
        raise ValueError(
            "{} non-executable boundary cannot contain a request body".format(
                skill_id
            )
        )

    fallback_contract = operation.get("fallback_contract")
    if fallback_contract is not None:
        if tool in PROXY_TOOLS:
            raise ValueError(
                "{} proxy operation cannot declare a separate "
                "fallback_contract".format(skill_id)
            )
        if is_boundary:
            raise ValueError(
                "{} non-executable boundary cannot declare a "
                "fallback_contract".format(skill_id)
            )
        _validate_fallback_contract(
            skill_id,
            fallback_contract,
            allowed_providers,
        )

    command_text = operation.get("command")
    if is_boundary and command_text is not None:
        raise ValueError(
            "{} non-executable boundary cannot declare a command".format(
                skill_id
            )
        )
    if command_text is None:
        if fallback_contract is not None:
            raise ValueError(
                "{} fallback_contract requires a command".format(skill_id)
            )
        return
    _validate_string(command_text, "legacy command", skill_id)
    actual_contract = _command_http_contract(skill_id, command_text)
    if actual_contract["provider_config_key"] not in allowed_providers:
        raise ValueError(
            "{} operation uses undeclared provider {}".format(
                skill_id,
                actual_contract["provider_config_key"],
            )
        )
    if fallback_contract is not None:
        expected_contract = _normalized_http_contract(
            fallback_contract["provider_config_key"],
            fallback_contract,
        )
    elif tool in PROXY_TOOLS:
        expected_contract = _normalized_http_contract(
            operation_provider,
            operation,
        )
    else:
        raise ValueError(
            "{} command for a non-HTTP typed tool requires a separate "
            "fallback_contract".format(skill_id)
        )
    if actual_contract != expected_contract:
        raise ValueError(
            "{} fallback command does not match its structured contract".format(
                skill_id
            )
        )


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


def _pagination_guidance(entry):
    mode = PAGINATION_MODES.get(entry["id"])
    if mode is None:
        return []

    lines = [
        "### Pagination result contract",
        "",
        "Return the bounded pages and the tool's termination reason. If a "
        "configured page or item bound stops the read, report that bound instead "
        "of claiming the provider collection is complete.",
        "",
    ]
    if entry["family"] == "bitrix24":
        lines.extend(
            [
                "For Bitrix24 `offset` pagination, use the provider `next` value "
                "as the next request's `start`; stop at provider end or the "
                "configured bounds.",
                "",
            ]
        )
    elif entry["family"] == "amocrm":
        lines.extend(
            [
                "For amoCRM `link` pagination, follow only a verified same-origin "
                "next link within the configured bounds. Never fetch an absolute "
                "next URL directly.",
                "",
            ]
        )
    elif entry["id"] == "yandex-direct":
        lines.extend(
            [
                "For Yandex Direct `body-offset` pagination, advance "
                "`Page.Offset` by the preserved `Page.Limit`. Return the terminal "
                "page and the termination reason.",
                "",
            ]
        )
    return lines


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
            "Use `nango_proxy_request` for a Direct mutation. After a confirmed "
            "mutation, read the campaign with a `get` request and compare the "
            "intended fields. If the outcome is `unknown`, including a dispatched "
            "timeout, inspect campaign state before any retry.",
            "",
        ]
    if skill_id == "bitrix24-crm":
        return [
            "### Deal update",
            "",
            "Use `nango_proxy_request` for a deal update:",
            "",
            "```json",
            *_json_lines(
                {
                    "providerConfigKey": "bitrix24-crm",
                    "method": "POST",
                    "path": "crm.deal.update",
                    "jsonBody": {
                        "id": "<confirmed-deal-id>",
                        "fields": {"TITLE": "<new-title>"},
                    },
                }
            ),
            "```",
            "",
            "After a confirmed update, read the deal through `crm.deal.get` and "
            "compare the intended fields. If the outcome is `unknown`, including "
            "a dispatched timeout, inspect the same deal before any retry.",
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
                        "msgid": "<stable-unique-message-id>",
                        "conversationId": "<confirmed-conversation-id>",
                        "receiver": {
                            "id": "<confirmed-receiver-id>",
                            "name": "<receiver-display-name>",
                        },
                        "text": "Hello",
                        "silent": False,
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
    if any(not isinstance(entry, dict) for entry in entries):
        raise ValueError("each catalog skill must be an object")
    if tuple(entry.get("id") for entry in entries) != EXPECTED_SKILL_IDS:
        raise ValueError("catalog must contain the exact ordered skill ids")
    if (
        tuple(entry.get("provider_config_key") for entry in entries)
        != EXPECTED_SKILL_IDS
    ):
        raise ValueError(
            "catalog must contain the exact ordered provider_config_key values"
        )

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
            _validate_operation(skill_id, operation, allowed_providers)

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
    lines.extend(_pagination_guidance(entry))
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
        ]
    )
    fallback_operations = [
        operation for operation in entry["operations"] if "command" in operation
    ]
    if fallback_operations:
        lines.append("```bash")
    for operation in fallback_operations:
        comment = operation["title"]
        if "fallback_contract" in operation:
            comment = "{} — diagnostic proxy fallback; does not exercise {}".format(
                comment,
                operation["tool"],
            )
        lines.extend(
            [
                "# {}".format(comment),
                "python3 {{baseDir}}/scripts/nango_proxy.py {}".format(
                    operation["command"]
                ),
            ]
        )
    if fallback_operations:
        lines.extend(["```", ""])
    else:
        lines.extend(
            [
                "No catalog fallback command is published for this unavailable "
                "product contract. The generic client remains packaged for an "
                "operator-supplied documented path.",
                "",
            ]
        )
    lines.extend(
        [
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


def _typed_tool_call(entry, operation):
    if operation["tool"] is None:
        return None
    arguments = {
        "providerConfigKey": operation.get(
            "provider_config_key",
            entry["provider_config_key"],
        )
    }
    tool = operation["tool"]
    if tool in {"nango_proxy_request", "nango_proxy_paginate"}:
        arguments.update(
            {
                "method": operation["method"],
                "path": operation["path"],
            }
        )
        source_to_argument = (
            ("query", "query"),
            ("headers", "headers"),
            ("json_body", "jsonBody"),
            ("text_body", "textBody"),
            ("content_type", "contentType"),
        )
        for source, argument in source_to_argument:
            if source in operation:
                arguments[argument] = operation[source]
        if tool == "nango_proxy_paginate":
            pagination = operation["pagination"]
            arguments.update(
                {
                    "mode": pagination["mode"],
                    "maxPages": pagination["max_pages"],
                    "maxItems": pagination["max_items"],
                }
            )
    elif tool == "nango_action":
        arguments.update(
            {
                "actionName": operation["action_name"],
                "input": operation["action_input"],
            }
        )
    elif tool == "nango_disk_transfer":
        arguments.update(operation["transfer"])
    return {"tool": tool, "arguments": arguments}


def _method_label(operation):
    if operation["method"] is not None:
        return "`{}`".format(operation["method"])
    if operation["tool"] == "nango_action":
        return "Not applicable — the registered action owns its transport."
    if operation["tool"] == "nango_disk_transfer":
        return "Not applicable — the transfer tool owns its provider phases."
    return "Not verified."


def _path_label(operation):
    if operation["path"] is not None:
        return "`{}`".format(operation["path"])
    if operation["tool"] == "nango_action":
        return "Not applicable — registered action `{}`.".format(
            operation["action_name"]
        )
    if operation["tool"] == "nango_disk_transfer":
        return (
            "Not applicable — use typed `localPath` and `remotePath`; never "
            "supply a presigned URL."
        )
    return "Not verified."


def _request_shape_label(operation):
    tool = operation["tool"]
    if tool in {"nango_proxy_request", "nango_proxy_paginate"}:
        parts = ["method and relative path"]
        if "query" in operation:
            parts.append("ordered `query` name/value pairs")
        if "headers" in operation:
            parts.append("bounded `headers`")
        if "json_body" in operation:
            parts.append("`jsonBody`")
        if "text_body" in operation:
            parts.append("`textBody`")
        if "content_type" in operation:
            parts.append("explicit `contentType`")
        return ", ".join(parts) + "; see the exact typed arguments below."
    if tool == "nango_action":
        return "Registered action `{}` with a strict `input` object.".format(
            operation["action_name"]
        )
    if tool == "nango_disk_transfer":
        return (
            "Typed direction, configured-root local path, provider-relative "
            "remote path, and overwrite flag."
        )
    if operation["availability"] == "blocked_contract":
        return (
            "Unavailable — exact body fields and a readback/reconciliation "
            "contract are not verified."
        )
    return "Unavailable — no verified public request schema exists."


def _pagination_label(operation):
    pagination = operation["pagination"]
    mode = pagination["mode"]
    if mode == "none":
        return "None — one bounded tool call."
    if mode == "action-window":
        return (
            "`action-window`: page limit {page_limit}, caller max items "
            "{max_items}. {continuation}"
        ).format(**pagination)
    if mode == "single":
        return (
            "`single`: one response, `maxPages={}`, `maxItems={}`. For CalDAV "
            "the XML body is one item, so maxItems is not an event count."
        ).format(pagination["max_pages"], pagination["max_items"])
    return (
        "`{}` with `maxPages={}` and `maxItems={}`; report the termination "
        "reason."
    ).format(mode, pagination["max_pages"], pagination["max_items"])


def _mutability_label(operation):
    operation_kind = operation["operation_kind"]
    if operation_kind == "read":
        return "`read` — no mutation approval."
    if operation_kind == "mutation":
        return "`mutation` — one-time approval is required before execution."
    return "`unsupported` — no executable operation is classified."


def _docs_label(operation):
    docs = operation["docs"]
    if docs["status"] == "verified":
        return "[verified provider documentation]({})".format(docs["url"])
    return (
        "`not_verified` — no authoritative documentation URL is recorded for "
        "this operation."
    )


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
        "## Operations",
        "",
    ]
    for operation in entry["operations"]:
        lines.extend(
            [
                "### {}".format(operation["title"]),
                "",
                "- **Operation name:** `{}`".format(operation["title"]),
                "- **Availability:** `{}`".format(operation["availability"]),
                "- **Method:** {}".format(_method_label(operation)),
                "- **Path:** {}".format(_path_label(operation)),
                "- **Request shape:** {}".format(
                    _request_shape_label(operation)
                ),
                "- **Pagination:** {}".format(_pagination_label(operation)),
                "- **Mutability:** {}".format(_mutability_label(operation)),
                "- **Verification:** {}".format(operation["verification"]),
                "- **Authoritative docs:** {}".format(
                    _docs_label(operation)
                ),
                "",
            ]
        )
        tool_call = _typed_tool_call(entry, operation)
        if tool_call is None:
            lines.extend(
                [
                    "#### Non-executable boundary",
                    "",
                    "No executable typed tool call or catalog fallback command "
                    "is available. Keep the packaged generic HTTP client for "
                    "operator-supplied documented paths, but do not invent this "
                    "missing product contract.",
                    "",
                ]
            )
        else:
            if operation["availability"] == "template":
                lines.extend(
                    [
                        "This is a **non-executable template**. Replace every "
                        "`REPLACE_WITH_...` value with a confirmed value inside "
                        "the configured runtime boundary before execution.",
                        "",
                    ]
                )
            lines.extend(
                [
                    "#### Typed tool call",
                    "",
                    "```json",
                    *_json_lines(tool_call),
                    "```",
                    "",
                ]
            )
        fallback_contract = operation.get("fallback_contract")
        if fallback_contract is not None:
            lines.extend(
                [
                    "#### Operator diagnostic fallback",
                    "",
                    "This separate diagnostic fallback uses `proxy_http` and "
                    "does not exercise `{}`. Its structured contract is:".format(
                        operation["tool"]
                    ),
                    "",
                    "```json",
                    *_json_lines(fallback_contract),
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
