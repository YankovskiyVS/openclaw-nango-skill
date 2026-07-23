import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "generate_skills.py"
VALIDATOR = ROOT / "scripts" / "validate_skills.py"
CATALOG = ROOT / "catalog" / "skills.json"


def _make_generated_repository(tmp_path):
    root = tmp_path / "repository"
    (root / "scripts").mkdir(parents=True)
    shutil.copy2(GENERATOR, root / "scripts" / "generate_skills.py")
    shutil.copy2(VALIDATOR, root / "scripts" / "validate_skills.py")
    shutil.copytree(ROOT / "_shared", root / "_shared")
    (root / "catalog").mkdir()
    shutil.copy2(CATALOG, root / "catalog" / "skills.json")
    generated = subprocess.run(
        [sys.executable, str(root / "scripts" / "generate_skills.py")],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
    )
    assert generated.returncode == 0, generated.stdout + generated.stderr
    return root


def _run_validator(root):
    return subprocess.run(
        [sys.executable, str(root / "scripts" / "validate_skills.py")],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
    )


def test_validator_accepts_the_canonical_generated_tree(tmp_path):
    assert VALIDATOR.is_file(), "scripts/validate_skills.py is missing"
    assert CATALOG.is_file(), "catalog/skills.json is missing"
    root = _make_generated_repository(tmp_path)

    result = _run_validator(root)

    assert result.returncode == 0, result.stdout + result.stderr
    assert "validated 25 skills" in result.stdout


def test_validator_reports_all_packaging_contract_violations(tmp_path):
    assert VALIDATOR.is_file(), "scripts/validate_skills.py is missing"
    root = _make_generated_repository(tmp_path)

    skill = root / "skills" / "yandex-direct" / "SKILL.md"
    text = skill.read_text(encoding="utf-8")
    text = text.replace(
        "description:",
        "timeout_sec: 300\ndescription:",
        1,
    )
    text = text.replace(
        """'{"method":"get","params":{"SelectionCriteria":{},"FieldNames":["Id","Name"]}}'""",
        """'{{"method":"get","params":{{"SelectionCriteria":{{}},"FieldNames":["Id","Name"]}}}}'""",
        1,
    )
    text = text.replace(
        "`{baseDir}/references/endpoints.md`",
        "`{baseDir}/references/missing.md`",
        1,
    )
    skill.write_text(text, encoding="utf-8")
    proxy = root / "skills" / "yandex-direct" / "scripts" / "nango_proxy.py"
    proxy.write_bytes(proxy.read_bytes() + b"\n# stale\n")
    (root / "skills" / "unexpected-skill").mkdir()

    result = _run_validator(root)

    assert result.returncode == 1
    output = result.stdout + result.stderr
    for marker in (
        "unsupported frontmatter",
        "invalid embedded JSON",
        "missing reference",
        "non-canonical scripts/nango_proxy.py",
        "unexpected skill directory",
    ):
        assert marker in output


def test_validator_rejects_symlinks_instead_of_canonical_packaged_files(tmp_path):
    root = _make_generated_repository(tmp_path)
    proxy = root / "skills" / "yandex-id" / "scripts" / "nango_proxy.py"
    proxy.unlink()
    proxy.symlink_to(root / "_shared" / "scripts" / "nango_proxy.py")

    result = _run_validator(root)

    assert result.returncode == 1
    assert "generated path must be a regular file" in (
        result.stdout + result.stderr
    )


def test_validator_requires_exact_frontmatter_values_and_nesting(tmp_path):
    root = _make_generated_repository(tmp_path)
    skill = root / "skills" / "yandex-id" / "SKILL.md"
    text = skill.read_text(encoding="utf-8")
    text = text.replace("name: yandex-id\n", "name: yandex-id-wrong\n", 1)
    text = text.replace("      bins: [python3]\n", "  bins: [python3]\n", 1)
    skill.write_text(text, encoding="utf-8")

    result = _run_validator(root)

    assert result.returncode == 1
    assert "frontmatter does not match catalog contract" in (
        result.stdout + result.stderr
    )
