import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CASES_PATH = ROOT / "evals" / "skill-cases.json"
BASELINE_PATH = ROOT / "evals" / "baseline.md"

UPSTREAM_BASELINE = "12903d917509fab4a4da4d7dd0489a42c00286e6"

EXPECTED_SKILLS = {
    "amocrm",
    "amocrm-catalog",
    "amocrm-chats",
    "amocrm-crm",
    "amocrm-events",
    "amocrm-tasks",
    "amocrm-telephony",
    "amocrm-users",
    "bitrix24",
    "bitrix24-bizproc",
    "bitrix24-calendar",
    "bitrix24-crm",
    "bitrix24-disk",
    "bitrix24-im",
    "bitrix24-tasks",
    "bitrix24-telephony",
    "bitrix24-user",
    "yandex-calendar",
    "yandex-delivery",
    "yandex-direct",
    "yandex-disk",
    "yandex-id",
    "yandex-mail",
    "yandex-maps",
    "yandex-market",
}

REQUIRED_RISK_CATEGORIES = {
    "routing",
    "pagination",
    "mutation_approval",
    "unknown_outcome",
    "yandex_mail_adapter",
    "yandex_calendar_caldav",
    "yandex_disk_transfer",
    "yandex_direct_json_rpc",
    "yandex_delivery_api_contract",
    "yandex_maps_public_api",
    "yandex_market_auth",
    "bitrix24_crm",
    "amocrm_chats_adapter",
}

ALLOWED_TOOLS = {
    None,
    "nango_proxy_request",
    "nango_proxy_paginate",
    "nango_action",
    "nango_disk_transfer",
}

EXACT_INVALID_COMMANDS = (
    "python3 {baseDir}/scripts/nango_proxy.py call yandex-direct "
    "json/v5/campaigns --method POST --json "
    """'{{"method":"get","params":{{"SelectionCriteria":{{}},"FieldNames":["Id","Name"]}}}}' """
    "--json-output",
    "python3 {baseDir}/scripts/nango_proxy.py call yandex-delivery "
    "api/b2b/platform/offers/create --method POST --json '{{}}' --json-output",
)


def test_skill_evaluation_baseline_is_complete() -> None:
    missing = [path.relative_to(ROOT).as_posix() for path in (CASES_PATH, BASELINE_PATH) if not path.is_file()]
    assert not missing, f"missing evaluation artifacts: {', '.join(missing)}"

    document = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    baseline = BASELINE_PATH.read_text(encoding="utf-8")

    assert document["schema_version"] == 1
    assert document["upstream_baseline"] == UPSTREAM_BASELINE
    assert set(document["risk_categories"]) == REQUIRED_RISK_CATEGORIES

    skill_dirs = {path.name for path in (ROOT / "skills").iterdir() if path.is_dir()}
    assert skill_dirs == EXPECTED_SKILLS

    cases = document["cases"]
    assert len(cases) >= len(EXPECTED_SKILLS)
    assert len({case["id"] for case in cases}) == len(cases)
    assert {case["skill"] for case in cases} == EXPECTED_SKILLS
    assert {case["expected"]["provider_config_key"] for case in cases} == EXPECTED_SKILLS

    covered_risks: set[str] = set()
    for case in cases:
        expected = case["expected"]
        risks = set(case["risk_categories"])

        assert case["skill"] in EXPECTED_SKILLS
        assert expected["provider_config_key"] == case["skill"]
        assert expected["tool"] in ALLOWED_TOOLS
        assert expected["operation_kind"] in {"read", "mutation", "unsupported"}
        assert expected["approval_behavior"] in {
            "not_required",
            "allow_once",
            "not_applicable",
        }
        assert isinstance(expected["verification_behavior"], str)
        assert expected["verification_behavior"].strip()
        assert risks
        assert risks <= REQUIRED_RISK_CATEGORIES

        if expected["operation_kind"] == "mutation":
            assert expected["approval_behavior"] == "allow_once"
        elif expected["operation_kind"] == "read":
            assert expected["approval_behavior"] == "not_required"
        else:
            assert expected["tool"] is None
            assert expected["approval_behavior"] == "not_applicable"

        covered_risks.update(risks)

    assert covered_risks == REQUIRED_RISK_CATEGORIES

    assert UPSTREAM_BASELINE in baseline
    for marker in ("STATIC", "REPRO", "NOT LIVE TESTED"):
        assert marker in baseline
    for command in EXACT_INVALID_COMMANDS:
        assert command in baseline
