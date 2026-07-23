import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODEL_EVAL = ROOT / "evals" / "model-functional"
VARIANTS = ("current", "upstream")


def load_json(name: str) -> dict:
    return json.loads((MODEL_EVAL / name).read_text(encoding="utf-8"))


def test_planning_eval_artifacts_and_totals_are_self_consistent() -> None:
    grading = load_json("aggregate-grading.json")
    cases = grading["cases"]

    assert grading["schema_version"] == "1.0"
    assert [case["eval_id"] for case in cases] == [
        f"eval{number:02d}" for number in range(1, 11)
    ]

    source_paths = [
        path
        for group in ("eval01_to_eval04", "eval05_to_eval10")
        for path in grading["sources"][group]
    ]
    assert len(source_paths) == len(set(source_paths)) == 10
    for relative_path in source_paths:
        source = ROOT / relative_path
        assert source.is_file(), relative_path
        assert source.stat().st_size > 0, relative_path

    totals = {
        variant: {"passed": 0, "failed": 0, "total": 0}
        for variant in VARIANTS
    }
    for case in cases:
        for variant in VARIANTS:
            result = case[variant]
            expectations = result["expectations"]
            summary = result["summary"]
            passed = sum(item["passed"] is True for item in expectations)
            failed = sum(item["passed"] is False for item in expectations)

            assert len(expectations) == 8
            assert all(item["text"] and item["evidence"] for item in expectations)
            assert summary == {
                "passed": passed,
                "failed": failed,
                "total": len(expectations),
                "pass_rate": passed / len(expectations),
            }
            totals[variant]["passed"] += passed
            totals[variant]["failed"] += failed
            totals[variant]["total"] += len(expectations)

    for variant in VARIANTS:
        aggregate = grading["aggregate"][variant]
        assert aggregate == {
            **totals[variant],
            "pass_rate": totals[variant]["passed"] / totals[variant]["total"],
        }

    current_wins = sum(
        case["current"]["summary"]["passed"] > case["upstream"]["summary"]["passed"]
        for case in cases
    )
    ties = sum(
        case["current"]["summary"]["passed"] == case["upstream"]["summary"]["passed"]
        for case in cases
    )
    upstream_wins = len(cases) - current_wins - ties
    comparison = grading["comparison_summary"]
    assert (current_wins, ties, upstream_wins) == (
        comparison["current_wins"],
        comparison["ties"],
        comparison["upstream_wins"],
    )
    assert grading["aggregate"]["current"]["passed"] == 80
    assert grading["aggregate"]["upstream"]["passed"] == 48
    assert grading["aggregate"]["by_category"]["registered_tool_or_null_boundary"] == {
        "current": "10/10",
        "upstream": "1/10",
    }


def test_routing_scores_are_recomputed_from_stored_outputs() -> None:
    audit = load_json("routing-audit.json")
    queries = audit["queries"]
    expected = {query["id"]: query["expected_skill"] for query in queries}

    assert audit["schema_version"] == "1.0"
    assert len(queries) == len(expected) == 24
    assert all(query["text"] for query in queries)

    for variant in VARIANTS:
        selected = audit["selected"][variant]
        matched = sum(selected[query_id] == skill for query_id, skill in expected.items())
        assert set(selected) == set(expected)
        assert audit["scores"][variant] == {
            "matched": matched,
            "total": len(expected),
            "accuracy": matched / len(expected),
        }

    assert audit["scores"]["current"]["matched"] == 24
    assert audit["scores"]["upstream"]["matched"] == 24
    assert audit["scores"]["identical_selected_maps"] is True
    assert audit["selected"]["current"] == audit["selected"]["upstream"]
