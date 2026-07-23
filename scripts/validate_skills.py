#!/usr/bin/env python3
"""Validate the generated OpenClaw skill packaging contract."""

from __future__ import annotations

import json
import os
import re
import stat
import sys
from pathlib import Path

from generate_skills import (
    CATALOG_FILE_MODE,
    GENERATED_PACKAGE_FILES,
    GENERATED_PACKAGE_MODES,
    ROOT,
    _trigger_phrase,
    load_catalog,
)


SUPPORTED_FRONTMATTER = {"name", "description", "metadata"}
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
    return "\n".join(
        [
            "name: {}".format(entry["name"]),
            "description: {}".format(
                json.dumps(
                    "{} tasks: {}.".format(
                        entry["title"], _trigger_phrase(entry)
                    ),
                    ensure_ascii=False,
                )
            ),
            "metadata: {}".format(metadata),
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


def _all_package_paths(package):
    paths = {}
    for directory, dirnames, filenames in os.walk(
        str(package), topdown=True, followlinks=False
    ):
        parent = Path(directory)
        for name in dirnames + filenames:
            path = parent / name
            paths[path.relative_to(package).as_posix()] = path
    return paths


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
    expected_directories = {"references", "scripts"}
    expected_paths = expected_files | expected_directories
    actual_paths = _all_package_paths(package)
    invalid_expected_path = False

    for relative in sorted(expected_directories):
        generated_path = package / relative
        if generated_path.is_symlink() or not generated_path.is_dir():
            errors.append(
                "{}: generated path must be a regular directory: {}".format(
                    skill_id, relative
                )
            )
            invalid_expected_path = True

    for relative in sorted(expected_files):
        generated_path = package / relative
        if generated_path.is_symlink():
            errors.append(
                "{}: generated path must be a regular file: {}".format(
                    skill_id, relative
                )
            )
            invalid_expected_path = True
        elif not generated_path.is_file():
            errors.append(
                "{}: missing generated file {}".format(skill_id, relative)
            )
            invalid_expected_path = True
        else:
            actual_mode = stat.S_IMODE(generated_path.stat().st_mode)
            expected_mode = GENERATED_PACKAGE_MODES[relative]
            if actual_mode != expected_mode:
                errors.append(
                    "{}: non-canonical mode {} (expected {:04o})".format(
                        skill_id, relative, expected_mode
                    )
                )

    for relative in sorted(set(actual_paths) - expected_paths):
        errors.append(
            "{}: unexpected package path {}".format(skill_id, relative)
        )
    if invalid_expected_path:
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

    canonical_proxy = ROOT / "_shared" / "scripts" / "nango_proxy.py"
    packaged_proxy = package / "scripts" / "nango_proxy.py"
    if packaged_proxy.read_bytes() != canonical_proxy.read_bytes():
        errors.append(
            "{}: non-canonical scripts/nango_proxy.py".format(skill_id)
        )
    canonical_reference = (
        ROOT / "_shared" / "references" / "api-reference.md"
    )
    packaged_reference = package / "references" / "api-reference.md"
    if packaged_reference.read_bytes() != canonical_reference.read_bytes():
        errors.append(
            "{}: non-canonical references/api-reference.md".format(skill_id)
        )

    for relative in BASEDIR_REFERENCE.findall(skill_text):
        if not (package / relative).is_file():
            errors.append(
                "{}: missing reference {{baseDir}}/{}".format(skill_id, relative)
            )

    markdown_paths = (
        package / "SKILL.md",
        package / "references" / "api-reference.md",
        package / "references" / "endpoints.md",
    )
    for markdown in markdown_paths:
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

    rendered_catalog = ROOT / "CATALOG.md"
    if rendered_catalog.is_symlink() or not rendered_catalog.is_file():
        errors.append("CATALOG.md must be a regular file")
    elif stat.S_IMODE(rendered_catalog.stat().st_mode) != CATALOG_FILE_MODE:
        errors.append(
            "non-canonical mode CATALOG.md (expected {:04o})".format(
                CATALOG_FILE_MODE
            )
        )

    skills_root = ROOT / "skills"
    if skills_root.is_symlink() or not skills_root.is_dir():
        errors.append("skills must be a regular directory")
        return errors, len(entries)

    expected_dirs = {entry["id"] for entry in entries}
    root_paths = {path.name: path for path in skills_root.iterdir()}
    valid_skill_dirs = set()
    for skill_id in sorted(expected_dirs):
        path = root_paths.get(skill_id)
        if path is None:
            errors.append("missing skill directory: {}".format(skill_id))
        elif path.is_symlink() or not path.is_dir():
            errors.append(
                "skill root path must be a regular directory: {}".format(
                    skill_id
                )
            )
        else:
            valid_skill_dirs.add(skill_id)
    for name in sorted(set(root_paths) - expected_dirs):
        errors.append("unexpected skill root path: {}".format(name))

    for entry in entries:
        if entry["id"] in valid_skill_dirs:
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
