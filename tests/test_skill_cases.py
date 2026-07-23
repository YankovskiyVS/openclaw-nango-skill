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


def test_paginated_eval_cases_document_their_result_and_cursor_contracts() -> None:
    document = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    paginated_cases = [
        case
        for case in document["cases"]
        if case["expected"]["tool"] == "nango_proxy_paginate"
    ]

    for case in paginated_cases:
        skill = case["skill"]
        skill_text = (ROOT / "skills" / skill / "SKILL.md").read_text(
            encoding="utf-8"
        )
        assert "termination reason" in skill_text, case["id"]
        if skill.startswith("bitrix24"):
            assert "next" in skill_text and "`start`" in skill_text, case["id"]
        if skill.startswith("amocrm"):
            assert "verified same-origin" in skill_text, case["id"]


def test_representative_eval_verification_contracts_reach_generated_artifacts() -> None:
    document = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    cases = {case["id"]: case for case in document["cases"]}
    contracts = {
        "yandex-direct-list-campaigns": {
            "verification": (
                "Advance Page.Offset within bounds and return the terminal page."
            ),
            "artifacts": {
                "skills/yandex-direct/SKILL.md": (
                    "`Page.Offset`",
                    "terminal page",
                ),
            },
        },
        "yandex-direct-update-campaign": {
            "verification": (
                "Read the campaign after success; after a dispatched timeout, "
                "inspect state before any retry."
            ),
            "artifacts": {
                "skills/yandex-direct/SKILL.md": (
                    "After a confirmed mutation, read the campaign",
                    "before any retry",
                ),
            },
        },
        "bitrix24-crm-list-leads": {
            "verification": (
                "Follow the Bitrix24 next/start offset within configured bounds."
            ),
            "artifacts": {
                "skills/bitrix24-crm/SKILL.md": (
                    "provider `next` value",
                    "`start`",
                ),
            },
        },
        "bitrix24-crm-update-deal": {
            "verification": (
                "Read the deal after success; after a dispatched timeout, inspect "
                "it before any retry."
            ),
            "artifacts": {
                "skills/bitrix24-crm/SKILL.md": (
                    '"path": "crm.deal.update"',
                    "After a confirmed update, read the deal",
                    "before any retry",
                ),
                "skills/bitrix24-crm/references/endpoints.md": (
                    "crm.deal.update",
                    "read the deal",
                ),
            },
        },
        "amocrm-crm-list-leads": {
            "verification": (
                "Follow only verified same-origin next links within bounds."
            ),
            "artifacts": {
                "skills/amocrm-crm/SKILL.md": ("verified same-origin",),
            },
        },
        "amocrm-chats-send-message": {
            "verification": (
                "Confirm the action message id; if dispatch is uncertain, inspect "
                "chat state before retrying."
            ),
            "artifacts": {
                "skills/amocrm-chats/SKILL.md": (
                    "Confirm the returned message id",
                    "inspect chat state",
                ),
                "skills/amocrm-chats/references/endpoints.md": (
                    "`nango_action`",
                    "`send-message`",
                ),
            },
        },
    }

    for case_id, contract in contracts.items():
        assert (
            cases[case_id]["expected"]["verification_behavior"]
            == contract["verification"]
        )
        for relative, fragments in contract["artifacts"].items():
            text = (ROOT / relative).read_text(encoding="utf-8")
            for fragment in fragments:
                assert fragment in text, "{}: {}".format(case_id, fragment)
