import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

from _shared.scripts import nango_proxy
from scripts import generate_skills


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "generate_skills.py"
CATALOG_SOURCE = ROOT / "catalog" / "skills.json"

EXPECTED_SKILLS = (
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

EXPECTED_OPERATIONS = {
    "yandex-id": (
        "call yandex-id info --query 'format=json' --json-output",
        "call yandex info --query 'format=json' --json-output",
    ),
    "yandex-disk": (
        "call yandex-disk v1/disk --json-output",
        "call yandex-disk 'v1/disk/resources' --query 'path=/' --json-output",
    ),
    "yandex-mail": (
        "call yandex-mail info --query 'format=json' --json-output",
    ),
    "yandex-calendar": (
        "call yandex-calendar calendars/ --method PROPFIND "
        "--header 'Depth: 1' "
        "--header 'Content-Type: application/xml; charset=utf-8' "
        "--text '<?xml version=\"1.0\" encoding=\"utf-8\"?>"
        "<d:propfind xmlns:d=\"DAV:\"><d:prop><d:displayname/></d:prop>"
        "</d:propfind>' --json-output",
    ),
    "yandex-direct": (
        "call yandex-direct json/v5/campaigns --method POST --json "
        """'{"method":"get","params":{"SelectionCriteria":{},"FieldNames":["Id","Name"],"""
        """"Page":{"Limit":100,"Offset":0}}}' """
        "--json-output",
    ),
    "yandex-maps": (),
    "yandex-market": ("call yandex-market v2/campaigns --json-output",),
    "yandex-delivery": (),
    "bitrix24": ("call bitrix24 user.current --json-output",),
    "bitrix24-crm": (
        "call bitrix24-crm crm.lead.list --json-output",
        "call bitrix24-crm crm.deal.list --json-output",
    ),
    "bitrix24-tasks": (
        "call bitrix24-tasks tasks.task.list --json-output",
    ),
    "bitrix24-disk": (
        "call bitrix24-disk disk.storage.getlist --json-output",
    ),
    "bitrix24-im": ("call bitrix24-im im.recent.get --json-output",),
    "bitrix24-user": (
        "call bitrix24-user user.current --json-output",
        "call bitrix24-user department.get --json-output",
    ),
    "bitrix24-calendar": (
        "call bitrix24-calendar calendar.section.get --json-output",
    ),
    "bitrix24-bizproc": (
        "call bitrix24-bizproc bizproc.workflow.template.list --json-output",
    ),
    "bitrix24-telephony": (
        "call bitrix24-telephony telephony.externalLine.get --json-output",
    ),
    "amocrm": ("call amocrm api/v4/account --json-output",),
    "amocrm-crm": (
        "call amocrm-crm api/v4/leads --json-output",
        "call amocrm-crm api/v4/contacts --json-output",
    ),
    "amocrm-catalog": (
        "call amocrm-catalog api/v4/catalogs --json-output",
    ),
    "amocrm-chats": ("call amocrm-chats api/v4/talks --json-output",),
    "amocrm-telephony": (
        "call amocrm-telephony api/v4/events "
        "--query 'filter[type]=incoming_call' --json-output",
    ),
    "amocrm-tasks": ("call amocrm-tasks api/v4/tasks --json-output",),
    "amocrm-events": ("call amocrm-events api/v4/events --json-output",),
    "amocrm-users": ("call amocrm-users api/v4/users --json-output",),
}

SUPPORTED_FRONTMATTER = {"name", "description", "metadata"}
GENERATED_PACKAGE_FILES = {
    "SKILL.md",
    "references/api-reference.md",
    "references/endpoints.md",
    "scripts/nango_proxy.py",
}
JSON_ARGUMENT = re.compile(r"--json '([^']*)'")
ENDPOINT_LABELS = (
    "**Operation name:**",
    "**Method:**",
    "**Path:**",
    "**Request shape:**",
    "**Pagination:**",
    "**Mutability:**",
    "**Verification:**",
    "**Authoritative docs:**",
)
READY_TOOLS = {
    "nango_proxy_request",
    "nango_proxy_paginate",
    "nango_action",
    "nango_disk_transfer",
}


def _frontmatter_keys(text):
    parts = text.split("---", 2)
    assert len(parts) == 3, "SKILL.md must start with YAML frontmatter"
    return {
        line.split(":", 1)[0]
        for line in parts[1].splitlines()
        if line and not line[0].isspace() and ":" in line
    }


def _invalid_json_arguments(path):
    invalid = []
    for match in JSON_ARGUMENT.finditer(path.read_text(encoding="utf-8")):
        payload = match.group(1)
        try:
            json.loads(payload)
        except json.JSONDecodeError as exc:
            invalid.append((payload, str(exc)))
    return invalid


def _make_repository(tmp_path, seed_skills=False):
    root = tmp_path / "repository"
    (root / "scripts").mkdir(parents=True)
    shutil.copy2(GENERATOR, root / "scripts" / "generate_skills.py")
    shutil.copytree(ROOT / "_shared", root / "_shared")
    if CATALOG_SOURCE.is_file():
        (root / "catalog").mkdir()
        shutil.copy2(CATALOG_SOURCE, root / "catalog" / "skills.json")
    if seed_skills:
        shutil.copytree(ROOT / "skills", root / "skills")
        shutil.copy2(ROOT / "CATALOG.md", root / "CATALOG.md")
    return root


def _run_generator(root, *arguments, umask=None):
    preexec_fn = None
    if umask is not None:
        preexec_fn = lambda: os.umask(umask)
    return subprocess.run(
        [sys.executable, str(root / "scripts" / "generate_skills.py"), *arguments],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
        preexec_fn=preexec_fn,
    )


def _snapshot(root, include_metadata):
    snapshot = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        path_stat = path.lstat()
        if path.is_symlink():
            value = ("symlink", path.readlink().as_posix())
        elif path.is_dir():
            value = ("directory",)
        elif path.is_file():
            value = ("file", path.read_bytes())
        else:
            value = ("special", stat.S_IFMT(path_stat.st_mode))
        if include_metadata:
            value += (path_stat.st_mode, path_stat.st_mtime_ns)
        snapshot[relative] = value
    return snapshot


def _mode(path):
    return stat.S_IMODE(path.stat().st_mode)


def test_catalog_is_the_ordered_source_for_all_existing_capabilities():
    assert CATALOG_SOURCE.is_file(), "catalog/skills.json is missing"
    document = json.loads(CATALOG_SOURCE.read_text(encoding="utf-8"))

    assert document["schema_version"] == 1
    entries = document["skills"]
    assert tuple(entry["id"] for entry in entries) == EXPECTED_SKILLS
    assert tuple(entry["provider_config_key"] for entry in entries) == EXPECTED_SKILLS
    assert len({entry["id"] for entry in entries}) == 25
    assert len({entry["provider_config_key"] for entry in entries}) == 25

    aliases = {
        entry["id"]: entry.get("aliases", [])
        for entry in entries
        if entry.get("aliases")
    }
    assert aliases == {"yandex-id": ["yandex"]}

    actual_operations = {
        entry["id"]: tuple(
            operation["command"]
            for operation in entry["operations"]
            if "command" in operation
        )
        for entry in entries
    }
    assert actual_operations == EXPECTED_OPERATIONS

    for entry in entries:
        allowed_providers = {entry["provider_config_key"], *entry.get("aliases", [])}
        for operation in entry["operations"]:
            required = {
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
            assert required <= set(operation)
            assert operation["availability"] in {
                "ready",
                "template",
                "unsupported",
                "blocked_contract",
            }
            assert operation["operation_kind"] in {
                "read",
                "mutation",
                "unsupported",
            }
            assert operation["pagination"]["mode"] in {
                "none",
                "single",
                "offset",
                "body-offset",
                "link",
                "action-window",
            }
            assert operation["docs"]["status"] in {"verified", "not_verified"}
            if operation["docs"]["status"] == "verified":
                assert operation["docs"]["url"] == (
                    "https://yandex.com/dev/disk/api/concepts/about.html"
                )
            else:
                assert operation["docs"]["url"] is None

            if operation["availability"] in {"ready", "template"}:
                assert operation["tool"] in READY_TOOLS
            else:
                assert operation["tool"] is None

            if "command" not in operation:
                continue
            command = shlex.split(operation["command"])
            assert command[0] == "call"
            assert command[1] in allowed_providers


def test_all_25_skill_frontmatters_are_plugin_first_and_runtime_parseable():
    skill_dirs = sorted(path.name for path in (ROOT / "skills").iterdir() if path.is_dir())
    assert set(skill_dirs) == set(EXPECTED_SKILLS)

    unsupported = {}
    malformed_metadata = []
    for skill_id in skill_dirs:
        text = (ROOT / "skills" / skill_id / "SKILL.md").read_text(encoding="utf-8")
        keys = _frontmatter_keys(text)
        if keys != SUPPORTED_FRONTMATTER:
            unsupported[skill_id] = sorted(keys - SUPPORTED_FRONTMATTER)
        metadata_line = next(
            (line for line in text.split("---", 2)[1].splitlines() if line.startswith("metadata: ")),
            None,
        )
        try:
            metadata = json.loads(metadata_line.removeprefix("metadata: "))
        except (AttributeError, json.JSONDecodeError):
            malformed_metadata.append(skill_id)
            continue
        if metadata.get("nango", {}).get("provider_config_key") != skill_id:
            malformed_metadata.append(skill_id)

        # The skill stays eligible when the plugin is installed even if the
        # operator-only Python fallback environment is absent.
        assert '"requires"' not in metadata_line
        assert "nango_proxy_request" in text
        assert "Operator-only fallback" in text

    assert unsupported == {}
    assert malformed_metadata == []


def test_generated_skills_explain_approval_and_unknown_outcome_contracts():
    forbidden_claims = (
        "On **401** — API key / IAM",
        "On **404** — wrong `EVOCLAW_ID`",
        "missing/expired OAuth → ask user",
        "OpenClaw never sees OAuth tokens",
    )

    for skill_id in EXPECTED_SKILLS:
        text = (ROOT / "skills" / skill_id / "SKILL.md").read_text(encoding="utf-8")
        assert "one-time approval" in text
        assert "`unknown`" in text
        assert "do not retry blindly" in text
        assert "Do not use the Python fallback to bypass approval" in text
        for claim in forbidden_claims:
            assert claim not in text


def test_provider_specific_skills_use_real_supported_surfaces():
    disk = (ROOT / "skills" / "yandex-disk" / "SKILL.md").read_text(encoding="utf-8")
    mail = (ROOT / "skills" / "yandex-mail" / "SKILL.md").read_text(encoding="utf-8")
    calendar = (ROOT / "skills" / "yandex-calendar" / "SKILL.md").read_text(encoding="utf-8")
    direct = (ROOT / "skills" / "yandex-direct" / "SKILL.md").read_text(encoding="utf-8")
    maps = (ROOT / "skills" / "yandex-maps" / "SKILL.md").read_text(encoding="utf-8")
    delivery = (ROOT / "skills" / "yandex-delivery" / "SKILL.md").read_text(encoding="utf-8")
    chats = (ROOT / "skills" / "amocrm-chats" / "SKILL.md").read_text(encoding="utf-8")

    assert "nango_disk_transfer" in disk
    assert all(
        action in mail
        for action in ("resolve-mailbox", "list-messages", "get-message", "send-message")
    )
    assert "IMAP/SMTP bridge" in mail
    assert "Do not extract or expose the OAuth token" in mail
    assert "PROPFIND" in calendar and "REPORT" in calendar and "CalDAV" in calendar
    assert "POST" in direct and '"method": "get"' in direct and "semantic read" in direct
    assert "No public bookmarks endpoint is confirmed" in maps
    assert "Do not invent `v1/`" in maps
    assert "offers/create" in delivery and "mutation" in delivery
    assert "Never use an empty create request as a health probe" in delivery
    assert "send-message" in chats and "nango_action" in chats


def test_generated_json_examples_are_literal_valid_json():
    invalid = {}
    for path in sorted((ROOT / "skills").glob("*/**/*.md")):
        failures = _invalid_json_arguments(path)
        if failures:
            invalid[path.relative_to(ROOT).as_posix()] = failures
    assert invalid == {}


def test_endpoint_references_use_typed_calls_and_resolve_skill_references():
    bad_endpoint_examples = []
    missing_references = []
    for skill_id in EXPECTED_SKILLS:
        skill_dir = ROOT / "skills" / skill_id
        endpoints = skill_dir / "references" / "endpoints.md"
        endpoint_text = endpoints.read_text(encoding="utf-8")
        if "```bash" in endpoint_text or "python3 " in endpoint_text:
            bad_endpoint_examples.append(skill_id)

        skill_text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
        for relative in re.findall(r"`\{baseDir\}/([^`]+)`", skill_text):
            if not (skill_dir / relative).is_file():
                missing_references.append((skill_id, relative))

    assert bad_endpoint_examples == []
    assert missing_references == []


def test_every_endpoint_operation_has_complete_typed_reference_or_boundary():
    document = json.loads(CATALOG_SOURCE.read_text(encoding="utf-8"))

    for entry in document["skills"]:
        endpoint_text = (
            ROOT / "skills" / entry["id"] / "references" / "endpoints.md"
        ).read_text(encoding="utf-8")
        for index, operation in enumerate(entry["operations"]):
            marker = "### {}".format(operation["title"])
            start = endpoint_text.index(marker)
            next_start = endpoint_text.find("\n### ", start + len(marker))
            section = endpoint_text[start : next_start if next_start != -1 else None]
            for label in ENDPOINT_LABELS:
                assert label in section, (entry["id"], operation["title"], label)

            if operation["availability"] in {"ready", "template"}:
                match = re.search(
                    r"#### Typed tool call\n\n```json\n(.*?)\n```",
                    section,
                    flags=re.DOTALL,
                )
                assert match is not None, (entry["id"], operation["title"])
                tool_call = json.loads(match.group(1))
                assert tool_call["tool"] == operation["tool"]
                assert tool_call["arguments"]["providerConfigKey"] == operation.get(
                    "provider_config_key",
                    entry["id"],
                )
                if operation["availability"] == "template":
                    assert "non-executable template" in section
            else:
                assert "#### Non-executable boundary" in section
                assert "#### Typed tool call" not in section


def test_special_endpoint_boundaries_match_registered_runtime_surfaces():
    refs = {
        skill_id: (
            ROOT / "skills" / skill_id / "references" / "endpoints.md"
        ).read_text(encoding="utf-8")
        for skill_id in (
            "yandex-calendar",
            "yandex-mail",
            "yandex-disk",
            "yandex-maps",
            "yandex-delivery",
        )
    }

    assert '"method": "PROPFIND"' in refs["yandex-calendar"]
    assert '"method": "REPORT"' in refs["yandex-calendar"]
    for action in (
        "resolve-mailbox",
        "list-messages",
        "get-message",
        "send-message",
    ):
        assert '"actionName": "{}"'.format(action) in refs["yandex-mail"]
    assert '"tool": "nango_proxy_request"' in refs["yandex-disk"]
    assert '"tool": "nango_proxy_paginate"' in refs["yandex-disk"]
    assert '"tool": "nango_disk_transfer"' in refs["yandex-disk"]
    assert "No executable typed tool call" in refs["yandex-maps"]
    assert '"path": "v1/"' not in refs["yandex-maps"]
    assert "No executable typed tool call" in refs["yandex-delivery"]
    assert (
        '"path": "api/b2b/platform/offers/create"'
        not in refs["yandex-delivery"]
    )


def test_boundary_operations_never_publish_executable_fallback_commands():
    document = json.loads(CATALOG_SOURCE.read_text(encoding="utf-8"))

    for entry in document["skills"]:
        for operation in entry["operations"]:
            if operation["availability"] in {
                "unsupported",
                "blocked_contract",
            }:
                assert "command" not in operation, (
                    entry["id"],
                    operation["title"],
                )
                skill_text = (
                    ROOT / "skills" / entry["id"] / "SKILL.md"
                ).read_text(encoding="utf-8")
                assert "```bash\n```" not in skill_text
                assert "No catalog fallback command is published" in skill_text


def test_legacy_alias_is_an_explicit_operation_level_provider_contract():
    document = json.loads(CATALOG_SOURCE.read_text(encoding="utf-8"))
    yandex_id = next(
        entry for entry in document["skills"] if entry["id"] == "yandex-id"
    )
    legacy = next(
        operation
        for operation in yandex_id["operations"]
        if operation["title"] == "legacy key"
    )
    endpoints = (
        ROOT / "skills" / "yandex-id" / "references" / "endpoints.md"
    ).read_text(encoding="utf-8")

    assert legacy["provider_config_key"] == "yandex"
    marker = "### {}".format(legacy["title"])
    start = endpoints.index(marker)
    section = endpoints[start:]
    assert '"providerConfigKey": "yandex"' in section


def test_action_diagnostic_fallback_has_a_separate_structured_contract():
    document = json.loads(CATALOG_SOURCE.read_text(encoding="utf-8"))
    yandex_mail = next(
        entry for entry in document["skills"] if entry["id"] == "yandex-mail"
    )
    resolve = next(
        operation
        for operation in yandex_mail["operations"]
        if operation["title"] == "Resolve mailbox email"
    )
    endpoints = (
        ROOT / "skills" / "yandex-mail" / "references" / "endpoints.md"
    ).read_text(encoding="utf-8")

    assert resolve["tool"] == "nango_action"
    assert resolve["fallback_contract"] == {
        "transport": "proxy_http",
        "operation_kind": "read",
        "provider_config_key": "yandex-mail",
        "method": "GET",
        "path": "info",
        "query": [{"name": "format", "value": "json"}],
    }
    assert "diagnostic fallback" in endpoints
    assert "does not exercise `nango_action`" in endpoints


def test_catalog_rejects_fallback_command_drift_from_structured_contract(
    tmp_path,
):
    root = _make_repository(tmp_path)
    document = json.loads(
        (root / "catalog" / "skills.json").read_text(encoding="utf-8")
    )
    operation = document["skills"][0]["operations"][0]
    operation["command"] = operation["command"].replace(
        "--query 'format=json'",
        "--query 'format=xml'",
    )
    (root / "catalog" / "skills.json").write_text(
        json.dumps(document),
        encoding="utf-8",
    )

    result = _run_generator(root)

    assert result.returncode == 2
    assert "fallback command does not match its structured contract" in (
        result.stdout + result.stderr
    )


def test_catalog_rejects_command_on_non_executable_boundary(tmp_path):
    root = _make_repository(tmp_path)
    document = json.loads(
        (root / "catalog" / "skills.json").read_text(encoding="utf-8")
    )
    maps = next(
        entry for entry in document["skills"] if entry["id"] == "yandex-maps"
    )
    maps["operations"][0]["command"] = (
        "call yandex-maps invented/path --json-output"
    )
    (root / "catalog" / "skills.json").write_text(
        json.dumps(document),
        encoding="utf-8",
    )

    result = _run_generator(root)

    assert result.returncode == 2
    assert "non-executable boundary cannot declare a command" in (
        result.stdout + result.stderr
    )


@pytest.mark.parametrize(
    ("name", "value"),
    (
        pytest.param(
            "Authorization",
            "catalog-header-secret",
            id="authorization",
        ),
        pytest.param(
            "Connection-Id",
            "catalog-header-secret",
            id="nango-control",
        ),
        pytest.param("Bad Header", "value", id="invalid-name"),
        pytest.param("X-Test", "line\r\nbreak", id="line-break"),
        pytest.param("X-Test", "café", id="non-ascii-value"),
        pytest.param(
            "Nango-Proxy-Nango-Proxy-Authorization",
            "catalog-header-secret",
            id="recursive-passthrough",
        ),
        pytest.param(
            "Nango-Proxy-X-Nango-Control",
            "catalog-header-secret",
            id="passthrough-blocked-prefix",
        ),
        pytest.param(
            "X-Cloud-Ru-Trace",
            "catalog-header-secret",
            id="cloudru-blocked-prefix",
        ),
        pytest.param(
            "X-Cloudru-Trace",
            "catalog-header-secret",
            id="cloudru-compact-blocked-prefix",
        ),
        pytest.param(
            "X-Evoclaw-Trace",
            "catalog-header-secret",
            id="evoclaw-blocked-prefix",
        ),
        pytest.param(
            "X-Evolution-Trace",
            "catalog-header-secret",
            id="evolution-blocked-prefix",
        ),
        pytest.param(
            "X-Nango-Trace",
            "catalog-header-secret",
            id="nango-blocked-prefix",
        ),
    ),
)
def test_catalog_rejects_headers_rejected_by_runtime(
    tmp_path,
    name,
    value,
):
    root = _make_repository(tmp_path)
    document = json.loads(
        (root / "catalog" / "skills.json").read_text(encoding="utf-8")
    )
    calendar = next(
        entry
        for entry in document["skills"]
        if entry["id"] == "yandex-calendar"
    )
    operation = calendar["operations"][0]
    operation["headers"] = {name: value}
    operation["command"] = operation["command"].replace(
        "--header 'Depth: 1'",
        "--header {}".format(shlex.quote("{}: {}".format(name, value))),
        1,
    )
    (root / "catalog" / "skills.json").write_text(
        json.dumps(document),
        encoding="utf-8",
    )

    result = _run_generator(root)

    assert result.returncode == 2
    output = result.stdout + result.stderr
    assert "header" in output.lower()
    assert "catalog-header-secret" not in output


def test_catalog_accepts_runtime_safe_depth_and_content_type_headers(tmp_path):
    root = _make_repository(tmp_path)

    result = _run_generator(root)

    assert result.returncode == 0, result.stdout + result.stderr
    calendar = (
        root / "skills" / "yandex-calendar" / "SKILL.md"
    ).read_text(encoding="utf-8")
    assert "--header 'Depth: 1'" in calendar
    assert (
        "--header 'Content-Type: application/xml; charset=utf-8'"
        in calendar
    )


def test_catalog_header_policy_matches_packaged_runtime_policy():
    assert (
        generate_skills._HEADER_NAME_RE.pattern
        == nango_proxy._HEADER_NAME_RE.pattern
    )
    assert (
        generate_skills._BLOCKED_REQUEST_HEADERS
        == nango_proxy._BLOCKED_REQUEST_HEADERS
    )
    assert (
        generate_skills._BLOCKED_REQUEST_HEADER_PREFIXES
        == nango_proxy._BLOCKED_REQUEST_HEADER_PREFIXES
    )
    assert (
        generate_skills._NANGO_PASSTHROUGH_HEADER_PREFIX
        == nango_proxy._NANGO_PASSTHROUGH_HEADER_PREFIX
    )


def test_all_packages_contain_canonical_shared_assets_with_canonical_modes():
    canonical_proxy_path = ROOT / "_shared" / "scripts" / "nango_proxy.py"
    canonical_reference_path = ROOT / "_shared" / "references" / "api-reference.md"
    canonical_proxy = canonical_proxy_path.read_bytes()
    canonical_reference = canonical_reference_path.read_bytes()
    stale = []
    for skill_id in EXPECTED_SKILLS:
        package = ROOT / "skills" / skill_id
        packaged_proxy = package / "scripts" / "nango_proxy.py"
        packaged_reference = package / "references" / "api-reference.md"
        if packaged_proxy.read_bytes() != canonical_proxy:
            stale.append((skill_id, "proxy bytes"))
        if _mode(packaged_proxy) != 0o755:
            stale.append((skill_id, "proxy mode"))
        if packaged_reference.read_bytes() != canonical_reference:
            stale.append((skill_id, "reference bytes"))
        if _mode(packaged_reference) != 0o644:
            stale.append((skill_id, "reference mode"))
    assert stale == []


def test_canonical_reference_documents_the_actual_fallback_and_typed_surfaces():
    reference = (
        ROOT / "_shared" / "references" / "api-reference.md"
    ).read_text(encoding="utf-8")
    proxy = (ROOT / "_shared" / "scripts" / "nango_proxy.py").read_text(
        encoding="utf-8"
    )

    for method in (
        "GET",
        "HEAD",
        "OPTIONS",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "PROPFIND",
        "REPORT",
    ):
        assert '"{}"'.format(method) in proxy
        assert "`{}`".format(method) in reference

    for flag in (
        "--proxy-url",
        "--project-id",
        "--evoclaw-id",
        "--api-key-file",
        "--timeout",
        "--method",
        "--query",
        "--header",
        "--json",
        "--text",
        "--body-file",
        "--json-output",
    ):
        assert flag in proxy
        assert "`{}`".format(flag) in reference

    for tool in (
        "nango_proxy_request",
        "nango_proxy_paginate",
        "nango_action",
        "nango_disk_transfer",
    ):
        assert "`{}`".format(tool) in reference

    assert "does not enforce the plugin approval proof" in reference
    assert all(
        outcome in reference
        for outcome in ("`confirmed`", "`not_started`", "`confirmed_failed`", "`unknown`")
    )


def test_check_mode_is_read_only_and_reports_missing_extra_and_stale(tmp_path):
    root = _make_repository(tmp_path, seed_skills=True)
    stale = root / "skills" / "yandex-id" / "SKILL.md"
    stale.write_text(stale.read_text(encoding="utf-8") + "\nstale\n", encoding="utf-8")
    (root / "skills" / "yandex-disk" / "SKILL.md").unlink()
    extra = root / "skills" / "local-unmanaged"
    extra.mkdir()
    (extra / "keep.txt").write_text("keep\n", encoding="utf-8")
    before = _snapshot(root, include_metadata=True)

    result = _run_generator(root, "--check")

    assert _snapshot(root, include_metadata=True) == before
    assert result.returncode == 1
    output = result.stdout + result.stderr
    assert "missing: skills/yandex-disk/SKILL.md" in output
    assert "stale: skills/yandex-id/SKILL.md" in output
    assert "extra: skills/local-unmanaged" in output


def test_normal_generation_preserves_unrelated_files_and_directories(tmp_path):
    root = _make_repository(tmp_path, seed_skills=True)
    local_dir = root / "skills" / "local-unmanaged"
    local_dir.mkdir()
    local_file = local_dir / "keep.txt"
    local_file.write_text("keep\n", encoding="utf-8")
    package_note = root / "skills" / "yandex-id" / "operator-note.md"
    package_note.write_text("keep this too\n", encoding="utf-8")

    result = _run_generator(root)

    assert result.returncode == 0, result.stdout + result.stderr
    assert local_file.read_text(encoding="utf-8") == "keep\n"
    assert package_note.read_text(encoding="utf-8") == "keep this too\n"


def test_normal_generation_refuses_symlinked_managed_directories(tmp_path):
    root = _make_repository(tmp_path)
    external = tmp_path / "external"
    external.mkdir()
    marker = external / "keep.txt"
    marker.write_text("outside\n", encoding="utf-8")
    (root / "skills").mkdir()
    (root / "skills" / "yandex-id").symlink_to(
        external, target_is_directory=True
    )
    before = _snapshot(root, include_metadata=True)

    result = _run_generator(root)

    assert result.returncode == 2
    assert _snapshot(root, include_metadata=True) == before
    assert sorted(path.name for path in external.iterdir()) == ["keep.txt"]
    assert marker.read_text(encoding="utf-8") == "outside\n"
    assert "refusing symlinked generated path" in result.stderr


def test_catalog_ids_cannot_escape_the_exact_skill_allowlist(tmp_path):
    root = _make_repository(tmp_path)
    document = json.loads(
        (root / "catalog" / "skills.json").read_text(encoding="utf-8")
    )
    escaped = document["skills"][1]
    escaped["id"] = "../../escaped-package"
    escaped["name"] = "../../escaped-package"
    escaped["provider_config_key"] = "../../escaped-package"
    for operation in escaped["operations"]:
        if "command" in operation:
            operation["command"] = operation["command"].replace(
                "call yandex-disk", "call ../../escaped-package", 1
            )
    (root / "catalog" / "skills.json").write_text(
        json.dumps(document), encoding="utf-8"
    )
    outside = tmp_path / "escaped-package"

    result = _run_generator(root)

    assert result.returncode == 2
    assert not outside.exists()
    assert "exact ordered skill ids" in result.stderr


def test_catalog_rejects_unverified_or_incomplete_operation_sources(tmp_path):
    root = _make_repository(tmp_path)
    document = json.loads(
        (root / "catalog" / "skills.json").read_text(encoding="utf-8")
    )
    operation = document["skills"][0]["operations"][0]
    operation["docs"] = {"status": "verified", "url": None}
    (root / "catalog" / "skills.json").write_text(
        json.dumps(document), encoding="utf-8"
    )

    result = _run_generator(root)

    assert result.returncode == 2
    assert "verified docs require an https URL" in result.stderr


def test_check_detects_generated_file_mode_drift_without_writing(tmp_path):
    root = _make_repository(tmp_path)
    generated = _run_generator(root)
    assert generated.returncode == 0, generated.stdout + generated.stderr
    proxy = root / "skills" / "yandex-id" / "scripts" / "nango_proxy.py"
    proxy.chmod(0o644)
    before = _snapshot(root, include_metadata=True)

    result = _run_generator(root, "--check")

    assert _snapshot(root, include_metadata=True) == before
    assert result.returncode == 1
    assert "stale: skills/yandex-id/scripts/nango_proxy.py" in (
        result.stdout + result.stderr
    )


def test_generation_and_check_use_canonical_modes_across_umasks(tmp_path):
    root = _make_repository(tmp_path)

    generated = _run_generator(root, umask=0o077)

    assert generated.returncode == 0, generated.stdout + generated.stderr
    assert _mode(root / "CATALOG.md") == 0o644
    wrong_modes = []
    for skill_id in EXPECTED_SKILLS:
        package = root / "skills" / skill_id
        expected_modes = {
            "SKILL.md": 0o644,
            "references/api-reference.md": 0o644,
            "references/endpoints.md": 0o644,
            "scripts/nango_proxy.py": 0o755,
        }
        for relative, expected_mode in expected_modes.items():
            actual_mode = _mode(package / relative)
            if actual_mode != expected_mode:
                wrong_modes.append((skill_id, relative, actual_mode))
    assert wrong_modes == []

    before = _snapshot(root, include_metadata=True)
    checked = _run_generator(root, "--check", umask=0o002)
    assert checked.returncode == 0, checked.stdout + checked.stderr
    assert _snapshot(root, include_metadata=True) == before


def test_check_reports_extra_paths_of_every_filesystem_type(tmp_path):
    root = _make_repository(tmp_path)
    generated = _run_generator(root)
    assert generated.returncode == 0, generated.stdout + generated.stderr
    root_extra = root / "skills" / "root-extra.txt"
    root_extra.write_text("extra\n", encoding="utf-8")
    (root / "skills" / "root-extra-link").symlink_to(root_extra)
    package = root / "skills" / "yandex-id"
    (package / "empty-extra").mkdir()
    os.mkfifo(package / "extra.fifo")
    before = _snapshot(root, include_metadata=True)

    checked = _run_generator(root, "--check")

    assert checked.returncode == 1
    assert _snapshot(root, include_metadata=True) == before
    output = checked.stdout + checked.stderr
    for path in (
        "skills/root-extra.txt",
        "skills/root-extra-link",
        "skills/yandex-id/empty-extra",
        "skills/yandex-id/extra.fifo",
    ):
        assert "extra: {}".format(path) in output


def test_two_generations_are_byte_stable_and_never_double_braces(tmp_path):
    root = _make_repository(tmp_path)

    first = _run_generator(root)
    assert first.returncode == 0, first.stdout + first.stderr
    first_snapshot = _snapshot(root, include_metadata=False)

    second = _run_generator(root)
    assert second.returncode == 0, second.stdout + second.stderr
    assert _snapshot(root, include_metadata=False) == first_snapshot

    invalid = {}
    for path in sorted((root / "skills").glob("*/**/*.md")):
        failures = _invalid_json_arguments(path)
        if failures:
            invalid[path.relative_to(root).as_posix()] = failures
    assert invalid == {}

    for skill_id in EXPECTED_SKILLS:
        package_files = {
            path.relative_to(root / "skills" / skill_id).as_posix()
            for path in (root / "skills" / skill_id).rglob("*")
            if path.is_file()
        }
        assert package_files == GENERATED_PACKAGE_FILES
