#!/usr/bin/env python3
"""Validate the generated OpenClaw skill packaging contract."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from generate_skills import (
    GENERATED_PACKAGE_FILES,
    REQUIRED_ENV,
    ROOT,
    load_catalog,
)


SUPPORTED_FRONTMATTER = {"name", "description", "allowed-tools", "metadata"}
JSON_ARGUMENT = re.compile(r"--json '([^']*)'")
BASEDIR_REFERENCE = re.compile(r"`\{baseDir\}/([^`]+)`")


def _frontmatter(text, skill_id, errors):
    if not text.startswith("---\n"):
        errors.append("{}: missing frontmatter".format(skill_id))
        return ""
    parts = text.split("---", 2)
    if len(parts) != 3:
        errors.append("{}: unterminated frontmatter".format(skill_id))
        return ""
    frontmatter = parts[1].strip("\n")
    keys = {
        line.split(":", 1)[0]
        for line in frontmatter.splitlines()
        if line and not line[0].isspace() and ":" in line
    }
    unsupported = sorted(keys - SUPPORTED_FRONTMATTER)
    missing = sorted(SUPPORTED_FRONTMATTER - keys)
    if unsupported:
        errors.append(
            "{}: unsupported frontmatter {}".format(
                skill_id, ", ".join(unsupported)
            )
        )
    if missing:
        errors.append(
            "{}: missing supported frontmatter {}".format(
                skill_id, ", ".join(missing)
            )
        )
    return frontmatter


def _expected_frontmatter(entry):
    return "\n".join(
        [
            "name: {}".format(entry["name"]),
            "description: {}".format(
                json.dumps(entry["description"], ensure_ascii=False)
            ),
            "allowed-tools: Fetch HTTP",
            "metadata:",
            "  openclaw:",
            "    requires:",
            "      env: [{}]".format(", ".join(REQUIRED_ENV)),
            "      bins: [python3]",
            "    primaryEnv: CLOUDRU_API_KEY",
            "  nango:",
            "    family: {}".format(entry["family"]),
            "    provider_config_key: {}".format(
                entry["provider_config_key"]
            ),
        ]
    )


def _validate_embedded_json(path, errors):
    text = path.read_text(encoding="utf-8")
    for match in JSON_ARGUMENT.finditer(text):
        try:
            json.loads(match.group(1))
        except json.JSONDecodeError as exc:
            errors.append(
                "{}: invalid embedded JSON: {}".format(
                    path.relative_to(ROOT).as_posix(), exc.msg
                )
            )


def _validate_package(entry, errors):
    skill_id = entry["id"]
    package = ROOT / "skills" / skill_id
    if package.is_symlink():
        errors.append(
            "{}: generated skill directory must not be a symlink".format(
                skill_id
            )
        )
        return
    expected_files = set(GENERATED_PACKAGE_FILES)
    actual_files = {
        path.relative_to(package).as_posix()
        for path in package.rglob("*")
        if path.is_file() or path.is_symlink()
    }
    invalid_expected_file = False
    for relative in sorted(expected_files):
        generated_path = package / relative
        if generated_path.is_symlink():
            errors.append(
                "{}: generated path must be a regular file: {}".format(
                    skill_id, relative
                )
            )
            invalid_expected_file = True
        elif not generated_path.is_file():
            errors.append(
                "{}: missing generated file {}".format(skill_id, relative)
            )
            invalid_expected_file = True
    for relative in sorted(actual_files - expected_files):
        errors.append(
            "{}: unexpected generated file {}".format(skill_id, relative)
        )
    if invalid_expected_file:
        return

    skill_path = package / "SKILL.md"
    skill_text = skill_path.read_text(encoding="utf-8")
    frontmatter = _frontmatter(skill_text, skill_id, errors)
    if frontmatter != _expected_frontmatter(entry):
        errors.append(
            "{}: frontmatter does not match catalog contract".format(skill_id)
        )
    if "name: {}".format(skill_id) not in frontmatter:
        errors.append("{}: frontmatter name does not match id".format(skill_id))

    env_requirement = "env: [{}]".format(", ".join(REQUIRED_ENV))
    if env_requirement not in frontmatter:
        errors.append("{}: missing openclaw env requirements".format(skill_id))
    if "bins: [python3]" not in frontmatter:
        errors.append("{}: missing openclaw bins requirement".format(skill_id))
    if "family: {}".format(entry["family"]) not in frontmatter:
        errors.append("{}: metadata family does not match catalog".format(skill_id))
    if (
        "provider_config_key: {}".format(entry["provider_config_key"])
        not in frontmatter
    ):
        errors.append(
            "{}: metadata provider_config_key does not match catalog".format(
                skill_id
            )
        )

    canonical_proxy = ROOT / "_shared" / "scripts" / "nango_proxy.py"
    packaged_proxy = package / "scripts" / "nango_proxy.py"
    if packaged_proxy.read_bytes() != canonical_proxy.read_bytes():
        errors.append(
            "{}: non-canonical scripts/nango_proxy.py".format(skill_id)
        )

    for relative in BASEDIR_REFERENCE.findall(skill_text):
        if not (package / relative).is_file():
            errors.append(
                "{}: missing reference {{baseDir}}/{}".format(skill_id, relative)
            )

    for markdown in sorted(package.glob("**/*.md")):
        for line in markdown.read_text(encoding="utf-8").splitlines():
            if line.startswith("python3 ") and not line.startswith(
                "python3 {baseDir}/scripts/nango_proxy.py "
            ):
                errors.append(
                    "{}: endpoint command is not basedir-relative: {}".format(
                        skill_id, line
                    )
                )
        _validate_embedded_json(markdown, errors)

    endpoints = (
        package / "references" / "endpoints.md"
    ).read_text(encoding="utf-8")
    for operation in entry["operations"]:
        command = "python3 {{baseDir}}/scripts/nango_proxy.py {}".format(
            operation["command"]
        )
        if command not in skill_text:
            errors.append(
                "{}: SKILL.md is missing catalog operation {}".format(
                    skill_id, operation["title"]
                )
            )
        if command not in endpoints:
            errors.append(
                "{}: endpoints.md is missing catalog operation {}".format(
                    skill_id, operation["title"]
                )
            )


def validate():
    errors = []
    try:
        entries = load_catalog()
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return ["catalog: {}".format(exc)], 0

    skills_root = ROOT / "skills"
    expected_dirs = {entry["id"] for entry in entries}
    if skills_root.is_dir():
        actual_dirs = {
            path.name for path in skills_root.iterdir() if path.is_dir()
        }
    else:
        actual_dirs = set()
    for skill_id in sorted(expected_dirs - actual_dirs):
        errors.append("missing skill directory: {}".format(skill_id))
    for skill_id in sorted(actual_dirs - expected_dirs):
        errors.append("unexpected skill directory: {}".format(skill_id))

    for entry in entries:
        if entry["id"] in actual_dirs:
            _validate_package(entry, errors)
    return errors, len(entries)


def main():
    errors, count = validate()
    if errors:
        for error in errors:
            print("error: {}".format(error), file=sys.stderr)
        return 1
    print("validated {} skills".format(count))
    return 0


if __name__ == "__main__":
    sys.exit(main())
