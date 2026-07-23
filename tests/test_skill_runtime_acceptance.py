from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlsplit

import pytest


ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "catalog" / "skills.json"
BASELINE_PATH = ROOT / "evals" / "baseline.md"
PROJECT_ID = "acceptance-project"
EVOCLAW_ID = "acceptance-claw"
API_KEY = "synthetic-cloudru-secret"
RESPONSE_HEADER_SECRET = "synthetic-response-header-secret"
PROXY_TOOLS = {"nango_proxy_request", "nango_proxy_paginate"}


@dataclass(frozen=True)
class CapturedRequest:
    method: str
    path: str
    raw_query: str
    query: list[tuple[str, str]]
    headers: dict[str, str]
    body: bytes


class FakeProxy:
    def __init__(self) -> None:
        self.requests: list[CapturedRequest] = []
        self._lock = threading.Lock()

        owner = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def _handle(self) -> None:
                parsed = urlsplit(self.path)
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                captured = CapturedRequest(
                    method=self.command,
                    path=parsed.path,
                    raw_query=parsed.query,
                    query=parse_qsl(parsed.query, keep_blank_values=True),
                    headers={
                        name.lower(): value for name, value in self.headers.items()
                    },
                    body=body,
                )
                with owner._lock:
                    owner.requests.append(captured)

                payload = json.dumps(
                    {"accepted": True, "requestMethod": self.command}
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("ETag", '"acceptance-etag"')
                self.send_header("Authorization", RESPONSE_HEADER_SECRET)
                self.send_header(
                    "Set-Cookie",
                    "acceptance-cookie={}".format(RESPONSE_HEADER_SECRET),
                )
                self.end_headers()
                self.wfile.write(payload)

            do_GET = _handle
            do_HEAD = _handle
            do_OPTIONS = _handle
            do_POST = _handle
            do_PUT = _handle
            do_PATCH = _handle
            do_DELETE = _handle
            do_PROPFIND = _handle
            do_REPORT = _handle

            def log_message(self, format: str, *args: object) -> None:
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        host, port = self.server.server_address
        self.url = "http://{}:{}".format(host, port)
        self._thread = threading.Thread(
            target=self.server.serve_forever,
            name="fake-nango-proxy",
            daemon=True,
        )
        self._thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self._thread.join(timeout=5)


@pytest.fixture(scope="session")
def fake_proxy() -> Any:
    proxy = FakeProxy()
    try:
        yield proxy
    finally:
        proxy.close()


def _catalog() -> list[dict[str, Any]]:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))["skills"]


def _ready_fallbacks() -> list[tuple[dict[str, Any], dict[str, Any]]]:
    return [
        (skill, operation)
        for skill in _catalog()
        for operation in skill["operations"]
        if operation["availability"] == "ready" and "command" in operation
    ]


def _case_id(value: tuple[dict[str, Any], dict[str, Any]]) -> str:
    skill, operation = value
    return "{}-{}".format(
        skill["id"],
        operation["title"].lower().replace(" ", "-"),
    )


READY_FALLBACKS = _ready_fallbacks()


def test_runtime_acceptance_inventory_is_complete() -> None:
    skills = _catalog()
    operations = [
        operation
        for skill in skills
        for operation in skill["operations"]
    ]

    assert len(skills) == 25
    assert len(operations) == 40
    assert len(READY_FALLBACKS) == 28
    assert sum(
        operation["availability"] == "ready" and "command" not in operation
        for operation in operations
    ) == 5
    assert sum(
        operation["availability"] in {"unsupported", "blocked_contract"}
        for operation in operations
    ) == 2


def _minimal_subprocess_env(proxy_url: str) -> dict[str, str]:
    environment = {
        "NANGO_PROXY_URL": proxy_url,
        "EVOLUTION_PROJECT_ID": PROJECT_ID,
        "EVOCLAW_ID": EVOCLAW_ID,
        "CLOUDRU_API_KEY": API_KEY,
        "PYTHONIOENCODING": "utf-8",
    }
    for name in ("PATH", "SYSTEMROOT"):
        if name in os.environ:
            environment[name] = os.environ[name]
    return environment


def _run_bundled_command(
    skill_id: str,
    command: str,
    proxy_url: str,
) -> subprocess.CompletedProcess[str]:
    script = ROOT / "skills" / skill_id / "scripts" / "nango_proxy.py"
    return subprocess.run(
        [sys.executable, str(script), *shlex.split(command)],
        cwd=ROOT,
        env=_minimal_subprocess_env(proxy_url),
        text=True,
        capture_output=True,
        check=False,
        timeout=15,
    )


def _declared_http_contract(
    skill: dict[str, Any],
    operation: dict[str, Any],
) -> dict[str, Any]:
    if operation["tool"] in PROXY_TOOLS:
        return {
            "provider_config_key": operation.get(
                "provider_config_key",
                skill["provider_config_key"],
            ),
            "method": operation["method"],
            "path": operation["path"],
            "query": operation.get("query", []),
            "headers": operation.get("headers", {}),
            **(
                {"json_body": operation["json_body"]}
                if "json_body" in operation
                else {}
            ),
            **(
                {"text_body": operation["text_body"]}
                if "text_body" in operation
                else {}
            ),
            **(
                {"content_type": operation["content_type"]}
                if "content_type" in operation
                else {}
            ),
        }

    fallback = operation.get("fallback_contract")
    assert fallback is not None, (
        "{} uses a command for a non-HTTP typed tool without declaring a "
        "separate fallback_contract".format(operation["title"])
    )
    assert fallback["transport"] == "proxy_http"
    return {
        key: value
        for key, value in fallback.items()
        if key not in {"transport", "operation_kind"}
    }


def _assert_wire_contract(
    captured: CapturedRequest,
    contract: dict[str, Any],
) -> None:
    provider = contract["provider_config_key"]
    expected_path = (
        "/api/v1/{}/evo-claws/{}/proxy/{}/{}".format(
            quote(PROJECT_ID, safe=""),
            quote(EVOCLAW_ID, safe=""),
            quote(provider, safe=""),
            contract["path"],
        )
    )
    expected_query = [
        (pair["name"], pair["value"]) for pair in contract.get("query", [])
    ]

    assert captured.method == contract["method"]
    assert captured.path == expected_path
    assert captured.query == expected_query
    assert captured.raw_query == urlencode(expected_query)
    assert captured.headers["authorization"] == "Api-Key {}".format(API_KEY)

    for name, value in contract.get("headers", {}).items():
        assert captured.headers[name.lower()] == value

    if "json_body" in contract:
        assert json.loads(captured.body) == contract["json_body"]
        assert captured.body == json.dumps(
            contract["json_body"],
            ensure_ascii=False,
        ).encode("utf-8")
        assert captured.headers["content-type"] == "application/json"
    elif "text_body" in contract:
        assert captured.body == contract["text_body"].encode("utf-8")
        assert captured.headers["content-type"] == contract["content_type"]
    else:
        assert captured.body == b""
        assert "content-type" not in captured.headers


@pytest.mark.parametrize(
    ("skill", "operation"),
    READY_FALLBACKS,
    ids=[_case_id(value) for value in READY_FALLBACKS],
)
def test_every_ready_fallback_command_round_trips_through_fake_proxy(
    fake_proxy: FakeProxy,
    skill: dict[str, Any],
    operation: dict[str, Any],
) -> None:
    before = len(fake_proxy.requests)
    result = _run_bundled_command(
        skill["id"],
        operation["command"],
        fake_proxy.url,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert len(fake_proxy.requests) == before + 1
    contract = _declared_http_contract(skill, operation)
    _assert_wire_contract(fake_proxy.requests[-1], contract)

    envelope = json.loads(result.stdout)
    assert envelope["ok"] is True
    assert envelope["outcome"] == "confirmed"
    assert envelope["request"] == {
        "providerConfigKey": contract["provider_config_key"],
        "method": contract["method"],
        "path": contract["path"],
    }
    assert envelope["response"]["status"] == 200
    assert envelope["response"]["headers"] == {
        "etag": '"acceptance-etag"',
    }
    assert API_KEY not in result.stdout + result.stderr
    assert RESPONSE_HEADER_SECRET not in result.stdout + result.stderr


@pytest.mark.parametrize("skill", _catalog(), ids=lambda skill: skill["id"])
def test_every_packaged_fallback_copy_starts_and_reaches_health(
    fake_proxy: FakeProxy,
    skill: dict[str, Any],
) -> None:
    script = ROOT / "skills" / skill["id"] / "scripts" / "nango_proxy.py"
    before = len(fake_proxy.requests)

    result = subprocess.run(
        [
            sys.executable,
            str(script),
            "--proxy-url",
            fake_proxy.url,
            "health",
        ],
        cwd=ROOT,
        env=_minimal_subprocess_env(fake_proxy.url),
        text=True,
        capture_output=True,
        check=False,
        timeout=15,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert len(fake_proxy.requests) == before + 1
    assert fake_proxy.requests[-1].method == "GET"
    assert fake_proxy.requests[-1].path == "/health"
    assert "HTTP 200" in result.stdout
    assert API_KEY not in result.stdout + result.stderr
    assert RESPONSE_HEADER_SECRET not in result.stdout + result.stderr


def test_non_executable_boundaries_publish_no_fallback_command() -> None:
    boundary_operations = [
        (skill["id"], operation)
        for skill in _catalog()
        for operation in skill["operations"]
        if operation["availability"] in {"unsupported", "blocked_contract"}
    ]

    assert boundary_operations
    for skill_id, operation in boundary_operations:
        assert "command" not in operation, (skill_id, operation["title"])


UPSTREAM_MALFORMED_COMMANDS = (
    (
        "yandex-direct",
        "call yandex-direct json/v5/campaigns --method POST --json "
        """'{{"method":"get","params":{{"SelectionCriteria":{{}},"FieldNames":["Id","Name"]}}}}' """
        "--json-output",
    ),
    (
        "yandex-delivery",
        "call yandex-delivery api/b2b/platform/offers/create --method POST "
        "--json '{{}}' --json-output",
    ),
)


@pytest.mark.parametrize(
    ("skill_id", "command"),
    UPSTREAM_MALFORMED_COMMANDS,
    ids=("upstream-yandex-direct", "upstream-yandex-delivery"),
)
def test_historical_malformed_json_examples_fail_before_io(
    fake_proxy: FakeProxy,
    skill_id: str,
    command: str,
) -> None:
    baseline = BASELINE_PATH.read_text(encoding="utf-8")
    assert command in baseline
    before = len(fake_proxy.requests)

    result = _run_bundled_command(skill_id, command, fake_proxy.url)

    assert result.returncode == 2
    assert len(fake_proxy.requests) == before
    envelope = json.loads(result.stdout)
    assert envelope["ok"] is False
    assert envelope["error"]["code"] == "invalid_request"
    assert envelope["outcome"] == "not_started"
    assert API_KEY not in result.stdout + result.stderr
