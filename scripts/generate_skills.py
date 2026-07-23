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
REQUIRED_ENV = (
    "NANGO_PROXY_URL",
    "EVOLUTION_PROJECT_ID",
    "EVOCLAW_ID",
    "CLOUDRU_API_KEY",
)


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
    env_list = ", ".join(REQUIRED_ENV)
    description = json.dumps(entry["description"], ensure_ascii=False)
    lines = [
        "---",
        "name: {}".format(entry["name"]),
        "description: {}".format(description),
        "allowed-tools: Fetch HTTP",
        "metadata:",
        "  openclaw:",
        "    requires:",
        "      env: [{}]".format(env_list),
        "      bins: [python3]",
        "    primaryEnv: CLOUDRU_API_KEY",
        "  nango:",
        "    family: {}".format(entry["family"]),
        "    provider_config_key: {}".format(entry["provider_config_key"]),
        "---",
        "",
        (
            "> **Required env:** `NANGO_PROXY_URL`, `EVOLUTION_PROJECT_ID`, "
            "`EVOCLAW_ID`, `CLOUDRU_API_KEY`  "
        ),
        "> **Required pip:** `httpx`  ",
        (
            "> **Install only if** this EvoClaw has OAuth connection for "
            "`{}` in Cloud.ru console.".format(entry["provider_config_key"])
        ),
        "",
        "## What this skill does",
        "",
        (
            "**{}** — authenticated HTTP via **ai-assistant-nango-proxy** "
            "→ Nango → provider API.".format(entry["title"])
        ),
        "",
        "- Nango `provider_config_key`: **`{}`**".format(
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
            "OpenClaw never sees OAuth tokens or the Nango secret.",
            "",
            "## When to use",
            "",
            entry["when"],
            "",
            (
                "Do **not** use for other vendors — install the matching skill "
                "(`yandex-*`, `bitrix24-*`, `amocrm-*`)."
            ),
            "",
            "## Prerequisites",
            "",
            (
                "1. User completed OAuth for **`{}`** on this EvoClaw in "
                "Cloud.ru console.".format(entry["provider_config_key"])
            ),
            (
                "2. Env injected (operator / pod): `NANGO_PROXY_URL`, "
                "`EVOLUTION_PROJECT_ID`, `EVOCLAW_ID`, `CLOUDRU_API_KEY`."
            ),
            "3. `pip install httpx` once per session if needed.",
            "",
            "Connection end-user id:",
            "",
            "```text",
            "project-{EVOLUTION_PROJECT_ID}-evoclaw-{EVOCLAW_ID}",
            "```",
            "",
            "## CLI",
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
            (
                "Flags: `--method`, `--json`, `--body-file`, `--query`, "
                "`--header`, `--timeout`, `--project-id`, `--evoclaw-id`, "
                "`--api-key`, `--proxy-url`, `--json-output`."
            ),
            "",
            "## Agent workflow",
            "",
            "1. Confirm the request matches **{}** (`{}`).".format(
                entry["title"], entry["provider_config_key"]
            ),
            (
                "2. Prefer `python3 {{baseDir}}/scripts/nango_proxy.py call {} …`."
            ).format(entry["provider_config_key"]),
            "3. On **401** — API key / IAM; do not invent alternate auth.",
            "4. On **404** — wrong `EVOCLAW_ID`.",
            (
                "5. On upstream **4xx/5xx** — missing/expired OAuth → ask user "
                "to reconnect **{}** in console.".format(
                    entry["provider_config_key"]
                )
            ),
            "6. Never log `CLOUDRU_API_KEY` or tokens.",
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


def render_tree(stage_root, entries):
    canonical_proxy = SHARED / "scripts" / "nango_proxy.py"
    canonical_reference = SHARED / "references" / "api-reference.md"
    if not canonical_proxy.is_file() or not canonical_reference.is_file():
        raise FileNotFoundError("canonical shared assets are missing")

    for entry in entries:
        destination = stage_root / "skills" / entry["id"]
        (destination / "scripts").mkdir(parents=True)
        (destination / "references").mkdir(parents=True)
        (destination / "SKILL.md").write_text(
            render_skill(entry), encoding="utf-8"
        )
        (destination / "references" / "endpoints.md").write_text(
            render_endpoints(entry), encoding="utf-8"
        )
        shutil.copy2(
            canonical_proxy, destination / "scripts" / "nango_proxy.py"
        )
        shutil.copy2(
            canonical_reference,
            destination / "references" / "api-reference.md",
        )
    (stage_root / "CATALOG.md").write_text(
        render_catalog(entries), encoding="utf-8"
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
