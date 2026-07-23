import hashlib
import json
from pathlib import Path
from typing import Callable

import httpx
import pytest

from _shared.scripts import nango_proxy


class _TrackingByteStream(httpx.SyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks
        self.chunks_read = 0
        self.closed = False

    def __iter__(self):
        for chunk in self._chunks:
            self.chunks_read += 1
            yield chunk

    def close(self) -> None:
        self.closed = True


def _install_mock_transport(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request], httpx.Response],
) -> list[dict[str, object]]:
    real_client = httpx.Client
    client_options: list[dict[str, object]] = []

    def client_factory(*args: object, **kwargs: object) -> httpx.Client:
        client_options.append(dict(kwargs))
        return real_client(
            *args,
            **kwargs,
            transport=httpx.MockTransport(handler),
        )

    monkeypatch.setattr(nango_proxy.httpx, "Client", client_factory)
    return client_options


def _set_call_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOLUTION_PROJECT_ID", "project/a")
    monkeypatch.setenv("EVOCLAW_ID", "evo claw")
    monkeypatch.setenv("CLOUDRU_API_KEY", "cloudru-secret")


def _parse_call_args(*extra: str) -> object:
    return nango_proxy.build_parser().parse_args(
        [
            "--proxy-url",
            "https://proxy.example/base",
            "call",
            "amocrm-crm",
            "api/v4/leads",
            *extra,
        ]
    )


def test_build_url_encodes_routing_and_preserves_ordered_query() -> None:
    url = nango_proxy.build_url(
        "https://proxy.example/base/",
        "project/a",
        "evo claw",
        "amocrm-crm",
        "api/v4/leads",
        "?tag=first&filter%5Bstatus%5D=active&tag=with%2Fslash",
    )

    assert url == (
        "https://proxy.example/base/api/v1/project%2Fa/evo-claws/evo%20claw"
        "/proxy/amocrm-crm/api/v4/leads"
        "?tag=first&filter%5Bstatus%5D=active&tag=with%2Fslash"
    )


def test_build_url_normalizes_legacy_flag_and_repeated_query_semantics() -> None:
    url = nango_proxy.build_url(
        "https://proxy.example",
        "project",
        "evoclaw",
        "amocrm-crm",
        "api/v4/leads",
        "flag&tag=first&tag=second",
    )

    assert url.endswith("?flag=&tag=first&tag=second")


def test_build_url_preserves_a_single_trailing_path_slash() -> None:
    assert nango_proxy.build_url(
        "https://proxy.example",
        "project",
        "evoclaw",
        "yandex-calendar",
        "calendars/",
        None,
    ) == (
        "https://proxy.example/api/v1/project/evo-claws/evoclaw"
        "/proxy/yandex-calendar/calendars/"
    )


@pytest.mark.parametrize(
    "proxy_url",
    [
        "ftp://proxy.example",
        "https://user:password@proxy.example",
        "https://proxy.example?target=provider",
        "https://proxy.example#fragment",
        "//proxy.example",
        "https:///missing-host",
    ],
)
def test_build_url_rejects_invalid_proxy_url(proxy_url: str) -> None:
    with pytest.raises(ValueError):
        nango_proxy.build_url(
            proxy_url,
            "project",
            "evoclaw",
            "amocrm-crm",
            "api/v4/leads",
            None,
        )


@pytest.mark.parametrize("provider", ["unknown", "amocrm/crm", "amocrm%2Fcrm"])
def test_build_url_rejects_non_catalog_provider(provider: str) -> None:
    with pytest.raises(ValueError):
        nango_proxy.build_url(
            "https://proxy.example",
            "project",
            "evoclaw",
            provider,
            "api/v4/leads",
            None,
        )


@pytest.mark.parametrize(
    "path",
    [
        "",
        "/api/v4/leads",
        "https://provider.example/api/v4/leads",
        "api//leads",
        "api/./leads",
        "api/%2e%2e/leads",
        "api/%2F/leads",
        "api\\v4\\leads",
        "api/v4/leads#fragment",
    ],
)
def test_build_url_rejects_unsafe_relative_path(path: str) -> None:
    with pytest.raises(ValueError):
        nango_proxy.build_url(
            "https://proxy.example",
            "project",
            "evoclaw",
            "amocrm-crm",
            path,
            None,
        )


@pytest.mark.parametrize("query", ["tag=%ZZ", "tag=value#fragment", "tag=line\r\nbreak"])
def test_build_url_rejects_unsafe_query(query: str) -> None:
    with pytest.raises(ValueError):
        nango_proxy.build_url(
            "https://proxy.example",
            "project",
            "evoclaw",
            "amocrm-crm",
            "api/v4/leads",
            query,
        )


def test_parse_headers_preserves_safe_provider_headers() -> None:
    assert nango_proxy._parse_headers(
        [
            "Depth: 1",
            "X-Provider-Feature: first:second",
            "Nango-Proxy-X-Provider-Feature: passthrough",
        ]
    ) == {
        "Depth": "1",
        "X-Provider-Feature": "first:second",
        "Nango-Proxy-X-Provider-Feature": "passthrough",
    }


@pytest.mark.parametrize(
    "header_name",
    [
        "Authorization",
        "Proxy-Authorization",
        "Cookie",
        "Set-Cookie",
        "Host",
        "Connection",
        "Keep-Alive",
        "Proxy-Connection",
        "TE",
        "Trailer",
        "Transfer-Encoding",
        "Upgrade",
        "Content-Length",
        "X-Nango-Connection-Id",
        "X-Api-Key",
        "X-Cloudru-Api-Key",
        "X-Evolution-Project-Id",
        "X-EvoClaw-Id",
        "Provider-Config-Key",
        "Connection-Id",
        "Retries",
        "Base-Url-Override",
        "Decompress",
        "X-HTTP-Method-Override",
        "X-HTTP-Method",
        "X-Method-Override",
        "Nango-Proxy-Authorization",
        "Nango-Proxy-Proxy-Authorization",
        "Nango-Proxy-Cookie",
        "Nango-Proxy-Set-Cookie",
        "Nango-Proxy-Host",
        "Nango-Proxy-Connection",
        "Nango-Proxy-Transfer-Encoding",
        "Nango-Proxy-Content-Length",
        "Nango-Proxy-Provider-Config-Key",
        "Nango-Proxy-Connection-Id",
        "Nango-Proxy-Retries",
        "Nango-Proxy-Base-Url-Override",
        "Nango-Proxy-Decompress",
        "Nango-Proxy-X-HTTP-Method-Override",
        "Nango-Proxy-Nango-Proxy-Authorization",
        "Nango-Proxy-X-Nango-Connection-Id",
    ],
)
def test_parse_headers_rejects_credential_routing_and_hop_headers(
    header_name: str,
) -> None:
    with pytest.raises(ValueError):
        nango_proxy._parse_headers([f"{header_name}: forbidden"])


@pytest.mark.parametrize(
    "raw_header",
    [
        "Bad Name: value",
        ": value",
        "X-Test\r\nInjected: value",
        "X-Test: value\r\nInjected: value",
        "X-Test: value\nInjected: value",
    ],
)
def test_parse_headers_rejects_invalid_names_and_line_breaks(raw_header: str) -> None:
    with pytest.raises(ValueError):
        nango_proxy._parse_headers([raw_header])


def test_parse_headers_does_not_echo_a_rejected_secret() -> None:
    secret = "top-secret-header-value"

    with pytest.raises(ValueError) as error:
        nango_proxy._parse_headers([f"Authorization: {secret}"])

    assert secret not in str(error.value)


@pytest.mark.parametrize("api_key", ["key\x00tail", "key\ttail", "key\x7ftail"])
def test_api_key_rejects_http_control_bytes_without_echoing_them(
    api_key: str,
) -> None:
    with pytest.raises(ValueError) as error:
        nango_proxy._validated_api_key(api_key)

    assert api_key not in str(error.value)


def test_non_ascii_header_value_is_rejected_safely_before_client_construction(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    secret = "секрет-заголовка"

    def forbidden_client(*args: object, **kwargs: object) -> None:
        raise AssertionError("invalid header must not create an HTTP client")

    monkeypatch.setattr(nango_proxy.httpx, "Client", forbidden_client)
    _set_call_environment(monkeypatch)

    assert (
        nango_proxy.cmd_call(
            _parse_call_args(
                "--header",
                f"X-Test: {secret}",
                "--json-output",
            )
        )
        == 2
    )

    captured = capsys.readouterr()
    assert secret not in captured.out
    assert secret not in captured.err


def test_build_body_serializes_json_as_utf8() -> None:
    headers: dict[str, str] = {}

    body = nango_proxy._build_body(
        json_body={"message": "привет"},
        text_body=None,
        body_file=None,
        headers=headers,
    )

    assert json.loads(body.decode("utf-8")) == {"message": "привет"}
    assert headers == {"Content-Type": "application/json"}


def test_build_body_encodes_text_without_overriding_content_type() -> None:
    headers = {"content-type": "text/calendar"}

    body = nango_proxy._build_body(
        json_body=None,
        text_body="BEGIN:VCALENDAR",
        body_file=None,
        headers=headers,
    )

    assert body == b"BEGIN:VCALENDAR"
    assert headers == {"content-type": "text/calendar"}


def test_build_body_reads_a_bounded_binary_file(tmp_path: Path) -> None:
    body_path = tmp_path / "body.bin"
    body_path.write_bytes(b"\x00\x01\x02")
    headers: dict[str, str] = {}

    body = nango_proxy._build_body(
        json_body=None,
        text_body=None,
        body_file=str(body_path),
        headers=headers,
    )

    assert body == b"\x00\x01\x02"
    assert headers == {}


def test_build_body_rejects_multiple_body_modes() -> None:
    with pytest.raises(ValueError, match="exactly one"):
        nango_proxy._build_body(
            json_body={"ok": True},
            text_body="also a body",
            body_file=None,
            headers={},
        )


@pytest.mark.parametrize(
    ("json_body", "text_body"),
    [
        ({"value": "too long"}, None),
        (None, "слишком длинно"),
    ],
)
def test_build_body_rejects_oversized_inline_body(
    monkeypatch: pytest.MonkeyPatch,
    json_body: object,
    text_body: str,
) -> None:
    monkeypatch.setattr(nango_proxy, "MAX_REQUEST_BODY_BYTES", 8)

    with pytest.raises(ValueError, match="size limit"):
        nango_proxy._build_body(
            json_body=json_body,
            text_body=text_body,
            body_file=None,
            headers={},
        )


def test_build_body_rejects_oversized_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(nango_proxy, "MAX_REQUEST_BODY_BYTES", 8)
    body_path = tmp_path / "large-body.bin"
    body_path.write_bytes(b"x" * 9)

    with pytest.raises(ValueError, match="size limit"):
        nango_proxy._build_body(
            json_body=None,
            text_body=None,
            body_file=str(body_path),
            headers={},
        )


def test_call_parser_accepts_a_text_body() -> None:
    args = nango_proxy.build_parser().parse_args(
        ["call", "yandex-calendar", "calendars/user/event.ics", "--text", "VEVENT"]
    )

    assert args.text == "VEVENT"


def test_call_parser_reports_mutually_exclusive_body_modes(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit):
        nango_proxy.build_parser().parse_args(
            [
                "call",
                "yandex-direct",
                "json/v5/campaigns",
                "--json",
                "{}",
                "--text",
                "also a body",
            ]
        )

    assert "not allowed with argument" in capsys.readouterr().err


def test_credentialed_proxy_call_never_follows_redirects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.host == "proxy.example":
            return httpx.Response(
                302,
                headers={
                    "location": "https://redirect.example/collect",
                    "set-cookie": "session=secret",
                },
                request=request,
            )
        return httpx.Response(200, json={"unexpected": "redirect"}, request=request)

    client_options = _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)
    args = _parse_call_args()

    exit_code = nango_proxy.cmd_call(args)

    assert client_options[0]["follow_redirects"] is False
    assert len(requests) == 1
    assert str(requests[0].url) == (
        "https://proxy.example/base/api/v1/project%2Fa/evo-claws/evo%20claw"
        "/proxy/amocrm-crm/api/v4/leads"
    )
    assert requests[0].headers["authorization"] == "Api-Key cloudru-secret"
    assert exit_code == 1


def test_json_response_uses_safe_envelope_and_allowlisted_headers(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"items": [{"id": 1}]},
            headers={
                "authorization": "Bearer provider-secret",
                "set-cookie": "session=cookie-secret",
                "x-provider-token": "provider-token-secret",
                "x-request-id": "req-123",
                "link": '</api/v4/leads?page=2>; rel="next"',
                "retry-after": "2",
                "etag": '"version-1"',
                "x-ratelimit-remaining": "9",
            },
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    exit_code = nango_proxy.cmd_call(_parse_call_args("--json-output"))

    output = capsys.readouterr().out
    envelope = json.loads(output)
    assert exit_code == 0
    assert "cloudru-secret" not in output
    assert "provider-secret" not in output
    assert "cookie-secret" not in output
    assert "provider-token-secret" not in output
    assert envelope == {
        "ok": True,
        "request": {
            "providerConfigKey": "amocrm-crm",
            "method": "GET",
            "path": "api/v4/leads",
        },
        "response": {
            "status": 200,
            "contentType": "application/json",
            "headers": {
                "etag": '"version-1"',
                "link": '</api/v4/leads?page=2>; rel="next"',
                "retry-after": "2",
                "x-ratelimit-remaining": "9",
                "x-request-id": "req-123",
            },
            "body": {"items": [{"id": 1}]},
        },
        "outcome": "confirmed",
    }


def test_binary_response_is_summarized_with_full_sha256(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    binary_body = b"\x00\xffprivate-binary\x80"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=binary_body,
            headers={"content-type": "application/octet-stream"},
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 0

    output = capsys.readouterr().out
    body = json.loads(output)["response"]["body"]
    assert body == {
        "kind": "binary",
        "size": len(binary_body),
        "contentType": "application/octet-stream",
        "sha256": hashlib.sha256(binary_body).hexdigest(),
    }
    assert len(body["sha256"]) == 64
    assert "private-binary" not in output


def test_oversized_text_response_is_rejected_without_exposing_body(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(nango_proxy, "MAX_RESPONSE_BYTES", 8)
    response_body = b"01234567must-not-appear"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=response_body,
            headers={"content-type": "text/plain; charset=utf-8"},
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 1

    output = capsys.readouterr().out
    assert json.loads(output)["error"] == {
        "layer": "unknown_upstream",
        "code": "invalid_response",
        "message": "Upstream response could not be parsed",
        "status": 200,
        "retryable": False,
    }
    assert "must-not-appear" not in output


@pytest.mark.parametrize("command", ["call", "health"])
def test_plain_output_cap_counts_utf8_replacement_status_and_newlines(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    command: str,
) -> None:
    monkeypatch.setattr(nango_proxy, "MAX_RESPONSE_BYTES", 40)
    response_body = b"\xff" * 8 + b"plain-tail-secret"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=response_body,
            headers={"content-type": "text/plain; charset=utf-8"},
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)
    if command == "call":
        exit_code = nango_proxy.cmd_call(_parse_call_args())
    else:
        args = nango_proxy.build_parser().parse_args(
            ["--proxy-url", "https://proxy.example", "health"]
        )
        exit_code = nango_proxy.cmd_health(args)

    assert exit_code == 0

    output = capsys.readouterr().out
    assert output.startswith("HTTP 200")
    assert len(output.encode("utf-8")) <= 40
    assert "plain-tail-secret" not in output


def test_oversized_json_response_is_rejected_without_parsing(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(nango_proxy, "MAX_RESPONSE_BYTES", 8)
    response_body = b'{"secret":"must-not-appear"}'

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=response_body,
            headers={"content-type": "application/json"},
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 1

    output = capsys.readouterr().out
    assert json.loads(output)["error"] == {
        "layer": "unknown_upstream",
        "code": "invalid_response",
        "message": "Upstream response could not be parsed",
        "status": 200,
        "retryable": False,
    }
    assert "must-not-appear" not in output


def test_oversized_http_error_preserves_status_and_retryability(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(nango_proxy, "MAX_RESPONSE_BYTES", 8)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            503,
            content=b"oversized-upstream-error",
            headers={"content-type": "text/plain"},
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 1

    output = capsys.readouterr().out
    assert json.loads(output)["error"] == {
        "layer": "unknown_upstream",
        "code": "upstream_http_error",
        "message": "Upstream request failed",
        "status": 503,
        "retryable": True,
    }


def test_oversized_redirect_response_remains_blocked(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(nango_proxy, "MAX_RESPONSE_BYTES", 8)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            302,
            content=b"oversized-redirect-body",
            headers={"location": "https://attacker.example/"},
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 1

    output = capsys.readouterr().out
    assert json.loads(output)["error"] == {
        "layer": "unknown_upstream",
        "code": "redirect_blocked",
        "message": "Credentialed redirect was blocked",
        "status": 302,
        "retryable": False,
    }
    assert "attacker.example" not in output


def test_validation_error_is_structured_and_never_dispatches(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def forbidden_client(*args: object, **kwargs: object) -> None:
        raise AssertionError("validation failure must not create an HTTP client")

    monkeypatch.setattr(nango_proxy.httpx, "Client", forbidden_client)
    _set_call_environment(monkeypatch)
    args = nango_proxy.build_parser().parse_args(
        [
            "--proxy-url",
            "https://proxy.example/base",
            "call",
            "not-in-catalog",
            "api/v1/data",
            "--json-output",
        ]
    )

    assert nango_proxy.cmd_call(args) == 2

    assert json.loads(capsys.readouterr().out) == {
        "ok": False,
        "request": {
            "providerConfigKey": "<invalid>",
            "method": "<invalid>",
            "path": "<invalid>",
        },
        "error": {
            "layer": "validation",
            "code": "invalid_request",
            "message": "Request validation failed",
            "retryable": False,
        },
        "outcome": "not_started",
    }


def test_validation_error_redacts_credential_like_invalid_path(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def forbidden_client(*args: object, **kwargs: object) -> None:
        raise AssertionError("validation failure must not create an HTTP client")

    monkeypatch.setattr(nango_proxy.httpx, "Client", forbidden_client)
    _set_call_environment(monkeypatch)
    args = nango_proxy.build_parser().parse_args(
        [
            "--proxy-url",
            "https://proxy.example/base",
            "call",
            "amocrm-crm",
            "https://user:path-secret@provider.example/api/v4/leads",
            "--json-output",
        ]
    )

    assert nango_proxy.cmd_call(args) == 2

    output = capsys.readouterr().out
    assert "path-secret" not in output
    assert json.loads(output)["request"]["providerConfigKey"] == "<invalid>"
    assert json.loads(output)["request"]["method"] == "<invalid>"
    assert json.loads(output)["request"]["path"] == "<invalid>"


@pytest.mark.parametrize(
    ("provider", "method", "path", "secret"),
    [
        ("provider-secret", "GET", "api/v1/data", "provider-secret"),
        ("amocrm-crm", "method-secret\r\nInjected", "api/v1/data", "method-secret"),
        ("amocrm-crm", "GET", "api/%ZZ-path-secret", "path-secret"),
    ],
)
def test_validation_failure_never_echoes_untrusted_routing_fields(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    provider: str,
    method: str,
    path: str,
    secret: str,
) -> None:
    def forbidden_client(*args: object, **kwargs: object) -> None:
        raise AssertionError("validation failure must not create an HTTP client")

    monkeypatch.setattr(nango_proxy.httpx, "Client", forbidden_client)
    _set_call_environment(monkeypatch)
    args = nango_proxy.build_parser().parse_args(
        [
            "--proxy-url",
            "https://proxy.example/base",
            "call",
            provider,
            path,
            "--method",
            method,
            "--json-output",
        ]
    )

    assert nango_proxy.cmd_call(args) == 2

    output = capsys.readouterr().out
    assert secret not in output
    assert json.loads(output)["request"] == {
        "providerConfigKey": "<invalid>",
        "method": "<invalid>",
        "path": "<invalid>",
    }


def test_malformed_json_body_is_rejected_without_argparse_echo(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    secret = "malformed-json-secret"

    def forbidden_client(*args: object, **kwargs: object) -> None:
        raise AssertionError("invalid JSON must not create an HTTP client")

    monkeypatch.setattr(nango_proxy.httpx, "Client", forbidden_client)
    _set_call_environment(monkeypatch)
    args = _parse_call_args(
        "--json",
        f'{{"token":"{secret}", invalid}}',
        "--json-output",
    )

    assert nango_proxy.cmd_call(args) == 2

    captured = capsys.readouterr()
    assert secret not in captured.out
    assert secret not in captured.err
    assert json.loads(captured.out)["error"]["layer"] == "validation"


def test_deeply_nested_request_json_is_a_safe_validation_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    secret = "deep-request-secret"
    json_body = "[" * 1200 + f'"{secret}"' + "]" * 1200

    def forbidden_client(*args: object, **kwargs: object) -> None:
        raise AssertionError("invalid JSON must not create an HTTP client")

    monkeypatch.setattr(nango_proxy.httpx, "Client", forbidden_client)
    _set_call_environment(monkeypatch)

    assert (
        nango_proxy.cmd_call(
            _parse_call_args("--json", json_body, "--json-output")
        )
        == 2
    )

    captured = capsys.readouterr()
    assert secret not in captured.out
    assert secret not in captured.err
    assert json.loads(captured.out)["error"] == {
        "layer": "validation",
        "code": "invalid_request",
        "message": "Request validation failed",
        "retryable": False,
    }


@pytest.mark.parametrize("credential_source", ["environment", "legacy"])
def test_credential_line_break_is_rejected_before_authorization_header(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    credential_source: str,
) -> None:
    secret = "credential-line-secret"

    def forbidden_client(*args: object, **kwargs: object) -> None:
        raise AssertionError("invalid credential must not create an HTTP client")

    monkeypatch.setattr(nango_proxy.httpx, "Client", forbidden_client)
    _set_call_environment(monkeypatch)
    extra: tuple[str, ...] = ()
    if credential_source == "environment":
        monkeypatch.setenv("CLOUDRU_API_KEY", f"prefix\r\n{secret}")
    else:
        monkeypatch.delenv("CLOUDRU_API_KEY")
        extra = ("--api-key", f"prefix\r\n{secret}")

    assert nango_proxy.cmd_call(_parse_call_args(*extra, "--json-output")) == 2

    captured = capsys.readouterr()
    assert secret not in captured.out
    assert secret not in captured.err


def test_explicit_upstream_layer_is_preserved_without_error_detail_leak(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            401,
            json={
                "proxyError": {
                    "schemaVersion": 1,
                    "layer": "nango",
                    "code": "connection_not_found",
                    "message": "provider-secret-detail",
                }
            },
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 1

    output = capsys.readouterr().out
    assert "provider-secret-detail" not in output
    assert json.loads(output)["error"] == {
        "layer": "nango",
        "code": "connection_not_found",
        "message": "Upstream request failed",
        "status": 401,
        "retryable": False,
    }


@pytest.mark.parametrize(
    "spoofed_metadata",
    [
        {
            "error": {
                "layer": "provider",
                "code": "connection_not_found",
                "message": "provider-spoof-secret",
            }
        },
        {
            "proxyError": {
                "schemaVersion": 1,
                "layer": "nango",
                "code": "attacker_chosen_code",
                "message": "code-spoof-secret",
            }
        },
    ],
)
def test_unverified_or_unknown_upstream_error_metadata_is_not_attributed(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    spoofed_metadata: dict[str, object],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json=spoofed_metadata, request=request)

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 1

    output = capsys.readouterr().out
    assert "spoof-secret" not in output
    assert json.loads(output)["error"] == {
        "layer": "unknown_upstream",
        "code": "upstream_http_error",
        "message": "Upstream request failed",
        "status": 401,
        "retryable": False,
    }


@pytest.mark.parametrize("status", [200, 502])
def test_deeply_nested_upstream_json_is_a_safe_invalid_response(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    status: int,
) -> None:
    secret = "deep-upstream-secret"
    response_body = (
        "[" * 1200 + f'"{secret}"' + "]" * 1200
    ).encode("utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status,
            content=response_body,
            headers={"content-type": "application/json"},
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 1

    captured = capsys.readouterr()
    assert secret not in captured.out
    assert secret not in captured.err
    envelope = json.loads(captured.out)
    assert envelope["error"] == {
        "layer": "unknown_upstream",
        "code": "invalid_response",
        "message": "Upstream response could not be parsed",
        "status": status,
        "retryable": False,
    }
    assert envelope["outcome"] == "confirmed_failed"


def test_deeply_nested_health_json_is_a_safe_invalid_response(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    secret = "deep-health-secret"
    response_body = (
        "[" * 1200 + f'"{secret}"' + "]" * 1200
    ).encode("utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=response_body,
            headers={"content-type": "application/json"},
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    args = nango_proxy.build_parser().parse_args(
        ["--proxy-url", "https://proxy.example", "health"]
    )

    assert nango_proxy.cmd_health(args) == 1

    captured = capsys.readouterr()
    assert secret not in captured.out
    assert secret not in captured.err
    assert (
        "ERROR unknown_upstream/invalid_response: Health response is invalid"
        in captured.out
    )


def test_mutation_http_failure_is_confirmed_and_not_retried(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            503,
            json={"message": "ambiguous-upstream-detail"},
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert (
        nango_proxy.cmd_call(
            _parse_call_args("--method", "POST", "--json", "{}", "--json-output")
        )
        == 1
    )

    output = capsys.readouterr().out
    envelope = json.loads(output)
    assert len(requests) == 1
    assert "ambiguous-upstream-detail" not in output
    assert envelope["error"] == {
        "layer": "unknown_upstream",
        "code": "upstream_http_error",
        "message": "Upstream request failed",
        "status": 503,
        "retryable": False,
    }
    assert envelope["outcome"] == "confirmed_failed"


def test_redirect_is_structured_without_inventing_proxy_provenance(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            307,
            headers={
                "location": "https://redirect.example/secret-target",
                "set-cookie": "redirect-cookie-secret",
            },
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 1

    output = capsys.readouterr().out
    envelope = json.loads(output)
    assert "redirect.example" not in output
    assert "redirect-cookie-secret" not in output
    assert envelope["error"] == {
        "layer": "unknown_upstream",
        "code": "redirect_blocked",
        "message": "Credentialed redirect was blocked",
        "status": 307,
        "retryable": False,
    }
    assert envelope["outcome"] == "confirmed_failed"


def test_not_modified_is_an_upstream_http_error_not_a_redirect(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(304, request=request)

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 1

    assert json.loads(capsys.readouterr().out)["error"] == {
        "layer": "unknown_upstream",
        "code": "upstream_http_error",
        "message": "Upstream request failed",
        "status": 304,
        "retryable": False,
    }


@pytest.mark.parametrize(
    "method",
    ["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "PROPFIND", "REPORT"],
)
def test_every_advertised_http_method_remains_callable(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    method: str,
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(204, request=request)

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert (
        nango_proxy.cmd_call(
            _parse_call_args("--method", method, "--json-output")
        )
        == 0
    )

    assert len(requests) == 1
    assert requests[0].method == method
    assert json.loads(capsys.readouterr().out)["request"]["method"] == method


@pytest.mark.parametrize("method", ["CONNECT", "TRACE", "MKCOL"])
def test_unadvertised_http_methods_are_rejected_before_dispatch(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    method: str,
) -> None:
    def forbidden_client(*args: object, **kwargs: object) -> None:
        raise AssertionError("unadvertised method must not create an HTTP client")

    monkeypatch.setattr(nango_proxy.httpx, "Client", forbidden_client)
    _set_call_environment(monkeypatch)

    assert (
        nango_proxy.cmd_call(
            _parse_call_args("--method", method, "--json-output")
        )
        == 2
    )

    assert json.loads(capsys.readouterr().out)["request"] == {
        "providerConfigKey": "<invalid>",
        "method": "<invalid>",
        "path": "<invalid>",
    }


def test_dispatched_mutation_timeout_has_unknown_outcome_and_no_retry(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        raise httpx.ReadTimeout(
            "timeout included cloudru-secret and must not be printed",
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert (
        nango_proxy.cmd_call(
            _parse_call_args("--method", "DELETE", "--json-output")
        )
        == 1
    )

    output = capsys.readouterr().out
    envelope = json.loads(output)
    assert len(requests) == 1
    assert "cloudru-secret" not in output
    assert envelope["error"] == {
        "layer": "network",
        "code": "mutation_timeout",
        "message": "Mutation timed out after dispatch; verify state before retrying",
        "retryable": False,
    }
    assert envelope["outcome"] == "unknown"


def test_read_network_failure_is_safe_and_retryable(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(
            "connection error included cloudru-secret and must not be printed",
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 1

    output = capsys.readouterr().out
    envelope = json.loads(output)
    assert "cloudru-secret" not in output
    assert envelope["error"] == {
        "layer": "network",
        "code": "network_error",
        "message": "Network request failed",
        "retryable": True,
    }
    assert envelope["outcome"] == "not_started"


def test_missing_body_file_is_a_safe_local_io_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    _set_call_environment(monkeypatch)
    missing_path = tmp_path / "secret-filename-must-not-leak.bin"

    assert (
        nango_proxy.cmd_call(
            _parse_call_args("--body-file", str(missing_path), "--json-output")
        )
        == 2
    )

    output = capsys.readouterr().out
    assert "secret-filename-must-not-leak" not in output
    assert json.loads(output)["error"] == {
        "layer": "local_io",
        "code": "body_file_error",
        "message": "Request body file could not be read",
        "retryable": False,
    }


@pytest.mark.parametrize("timeout", ["0", "-1", "301", "nan"])
def test_invalid_timeout_is_rejected_before_dispatch(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    timeout: str,
) -> None:
    def forbidden_client(*args: object, **kwargs: object) -> None:
        raise AssertionError("invalid timeout must not create an HTTP client")

    monkeypatch.setattr(nango_proxy.httpx, "Client", forbidden_client)
    _set_call_environment(monkeypatch)
    args = nango_proxy.build_parser().parse_args(
        [
            "--proxy-url",
            "https://proxy.example/base",
            "--timeout",
            timeout,
            "call",
            "amocrm-crm",
            "api/v4/leads",
            "--json-output",
        ]
    )

    assert nango_proxy.cmd_call(args) == 2
    assert json.loads(capsys.readouterr().out)["error"]["layer"] == "validation"


@pytest.mark.parametrize(
    "target",
    [
        ["call", "amocrm-crm", "api/v4/leads", "--json-output"],
        ["health"],
    ],
)
def test_non_numeric_timeout_is_rejected_without_argparse_echo(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    target: list[str],
) -> None:
    secret = "sentinel-timeout-secret"

    def forbidden_client(*args: object, **kwargs: object) -> None:
        raise AssertionError("invalid timeout must not create an HTTP client")

    monkeypatch.setattr(nango_proxy.httpx, "Client", forbidden_client)
    _set_call_environment(monkeypatch)
    args = nango_proxy.build_parser().parse_args(
        ["--timeout", secret, *target]
    )

    assert args.func(args) == 2

    captured = capsys.readouterr()
    assert secret not in captured.out
    assert secret not in captured.err


def test_common_call_options_parse_before_and_after_subcommand(
    tmp_path: Path,
) -> None:
    key_path = tmp_path / "cloudru-api-key"
    common = [
        "--proxy-url",
        "https://proxy.example/base",
        "--project-id",
        "project",
        "--evoclaw-id",
        "evoclaw",
        "--api-key-file",
        str(key_path),
        "--timeout",
        "12",
    ]
    target = ["call", "amocrm-crm", "api/v4/leads"]
    parser = nango_proxy.build_parser()

    before = parser.parse_args([*common, *target])
    after = parser.parse_args([*target, *common])

    for name in (
        "proxy_url",
        "project_id",
        "evoclaw_id",
        "api_key_file",
        "timeout",
    ):
        assert getattr(before, name) == getattr(after, name)


def test_legacy_api_key_parses_before_and_after_subcommand() -> None:
    target = ["call", "amocrm-crm", "api/v4/leads"]
    parser = nango_proxy.build_parser()

    before = parser.parse_args(["--api-key", "legacy-value", *target])
    after = parser.parse_args([*target, "--api-key", "legacy-value"])

    assert before.api_key == "legacy-value"
    assert after.api_key == "legacy-value"


def test_legacy_api_key_is_hidden_from_root_and_call_help(
    capsys: pytest.CaptureFixture[str],
) -> None:
    parser = nango_proxy.build_parser()
    root_help = parser.format_help()
    with pytest.raises(SystemExit):
        parser.parse_args(["call", "--help"])
    call_help = capsys.readouterr().out

    assert "--api-key-file" in root_help
    assert "--api-key-file" in call_help
    assert "--api-key " not in root_help
    assert "--api-key " not in call_help


def test_api_key_file_supplies_credential_without_leaking_it(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    key_path = tmp_path / "cloudru-api-key"
    key_path.write_text("file-secret\n", encoding="utf-8")
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"ok": True}, request=request)

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)
    monkeypatch.delenv("CLOUDRU_API_KEY")

    assert (
        nango_proxy.cmd_call(
            _parse_call_args(
                "--api-key-file",
                str(key_path),
                "--json-output",
            )
        )
        == 0
    )

    captured = capsys.readouterr()
    assert requests[0].headers["authorization"] == "Api-Key file-secret"
    assert "file-secret" not in captured.out
    assert "file-secret" not in captured.err


def test_legacy_api_key_warns_without_leaking_its_value(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"ok": True}, request=request)

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)
    monkeypatch.delenv("CLOUDRU_API_KEY")

    assert (
        nango_proxy.cmd_call(
            _parse_call_args(
                "--api-key",
                "legacy-secret",
                "--json-output",
            )
        )
        == 0
    )

    captured = capsys.readouterr()
    assert requests[0].headers["authorization"] == "Api-Key legacy-secret"
    assert "deprecated" in captured.err.lower()
    assert "legacy-secret" not in captured.out
    assert "legacy-secret" not in captured.err


def test_file_and_legacy_api_key_overrides_are_mutually_exclusive_across_parsers(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    key_path = tmp_path / "cloudru-api-key"
    key_path.write_text("file-secret\n", encoding="utf-8")
    _set_call_environment(monkeypatch)
    args = nango_proxy.build_parser().parse_args(
        [
            "--api-key-file",
            str(key_path),
            "call",
            "amocrm-crm",
            "api/v4/leads",
            "--api-key",
            "legacy-secret",
            "--json-output",
        ]
    )

    assert nango_proxy.cmd_call(args) == 2

    captured = capsys.readouterr()
    assert json.loads(captured.out)["error"]["layer"] == "validation"
    assert "file-secret" not in captured.out
    assert "legacy-secret" not in captured.out
    assert "legacy-secret" not in captured.err


def test_missing_api_key_file_is_a_safe_local_io_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    _set_call_environment(monkeypatch)
    monkeypatch.delenv("CLOUDRU_API_KEY")
    missing_path = tmp_path / "secret-key-filename-must-not-leak"
    args = nango_proxy.build_parser().parse_args(
        [
            "call",
            "amocrm-crm",
            "api/v4/leads",
            "--api-key-file",
            str(missing_path),
            "--json-output",
        ]
    )

    assert nango_proxy.cmd_call(args) == 2

    output = capsys.readouterr().out
    assert "secret-key-filename-must-not-leak" not in output
    assert json.loads(output)["error"] == {
        "layer": "local_io",
        "code": "api_key_file_error",
        "message": "API key file could not be read",
        "retryable": False,
    }


def test_health_rejects_invalid_proxy_url_before_dispatch(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def forbidden_client(*args: object, **kwargs: object) -> None:
        raise AssertionError("invalid health URL must not create an HTTP client")

    monkeypatch.setattr(nango_proxy.httpx, "Client", forbidden_client)
    args = nango_proxy.build_parser().parse_args(
        [
            "--proxy-url",
            "https://user:health-url-secret@proxy.example",
            "health",
        ]
    )

    assert nango_proxy.cmd_health(args) == 2

    captured = capsys.readouterr()
    assert "health-url-secret" not in captured.out
    assert "health-url-secret" not in captured.err


def test_oversized_health_response_is_rejected_and_redirects_are_disabled(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(nango_proxy, "MAX_RESPONSE_BYTES", 8)
    response_body = b"healthy!health-tail-secret"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=response_body,
            headers={"content-type": "text/plain; charset=utf-8"},
            request=request,
        )

    client_options = _install_mock_transport(monkeypatch, handler)
    args = nango_proxy.build_parser().parse_args(
        ["--proxy-url", "https://proxy.example", "health"]
    )

    assert nango_proxy.cmd_health(args) == 1

    output = capsys.readouterr().out
    assert client_options[0]["follow_redirects"] is False
    assert (
        "ERROR unknown_upstream/invalid_response: Health response is invalid"
        in output
    )
    assert "health-tail-secret" not in output


@pytest.mark.parametrize("command", ["call", "health"])
def test_oversized_response_stream_stops_at_limit_and_closes(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    command: str,
) -> None:
    monkeypatch.setattr(nango_proxy, "MAX_RESPONSE_BYTES", 8)
    stream = _TrackingByteStream(
        [b"1234", b"5678", b"9", b"stream-tail-secret"]
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            stream=stream,
            headers={"content-type": "text/plain; charset=utf-8"},
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)
    if command == "call":
        exit_code = nango_proxy.cmd_call(_parse_call_args("--json-output"))
    else:
        args = nango_proxy.build_parser().parse_args(
            ["--proxy-url", "https://proxy.example", "health"]
        )
        exit_code = nango_proxy.cmd_health(args)

    assert exit_code == 1
    assert stream.chunks_read == 3
    assert stream.closed is True
    captured = capsys.readouterr()
    assert "stream-tail-secret" not in captured.out
    assert "stream-tail-secret" not in captured.err


@pytest.mark.parametrize("command", ["call", "health"])
def test_oversized_content_length_is_rejected_before_body_read(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    command: str,
) -> None:
    monkeypatch.setattr(nango_proxy, "MAX_RESPONSE_BYTES", 8)
    stream = _TrackingByteStream([b"must-not-be-read"])

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            stream=stream,
            headers={
                "content-length": "9",
                "content-type": "text/plain; charset=utf-8",
            },
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)
    if command == "call":
        exit_code = nango_proxy.cmd_call(_parse_call_args("--json-output"))
    else:
        args = nango_proxy.build_parser().parse_args(
            ["--proxy-url", "https://proxy.example", "health"]
        )
        exit_code = nango_proxy.cmd_health(args)

    assert exit_code == 1
    assert stream.chunks_read == 0
    assert stream.closed is True
    captured = capsys.readouterr()
    assert "must-not-be-read" not in captured.out
    assert "must-not-be-read" not in captured.err


def test_oversized_allowlisted_response_header_is_omitted(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(nango_proxy, "MAX_RESPONSE_METADATA_BYTES", 8)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={"ok": True},
            headers={"x-request-id": "12345678header-tail-secret"},
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 0

    output = capsys.readouterr().out
    assert "header-tail-secret" not in output
    assert json.loads(output)["response"]["headers"] == {}


def test_oversized_content_type_is_omitted_from_output(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(nango_proxy, "MAX_CONTENT_TYPE_BYTES", 8)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            content=b"ok",
            headers={"content-type": "text/plain;content-type-tail-secret"},
            request=request,
        )

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 0

    output = capsys.readouterr().out
    assert "content-type-tail-secret" not in output
    assert json.loads(output)["response"]["contentType"] == ""


def test_json_envelope_is_serialized_compactly(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"items": [1, 2, 3]}, request=request)

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 0

    output = capsys.readouterr().out
    assert "\n" not in output.rstrip("\n")
    assert json.loads(output)["response"]["body"] == {"items": [1, 2, 3]}


def test_final_json_envelope_is_bounded_after_serialization(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(nango_proxy, "MAX_RESPONSE_BYTES", 4096)
    monkeypatch.setattr(nango_proxy, "MAX_JSON_OUTPUT_BYTES", 512)
    response_body = {"padding": "x" * 1024}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=response_body, request=request)

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 0

    output = capsys.readouterr().out
    envelope = json.loads(output)
    assert len(output.encode("utf-8")) <= 512
    assert "x" * 100 not in output
    assert envelope["response"]["body"]["truncated"] is True


def test_json_envelope_exact_boundary_does_not_add_newline(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    exact_caps: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        response = httpx.Response(200, json={"ok": True}, request=request)
        envelope = {
            "ok": True,
            "request": {
                "providerConfigKey": "amocrm-crm",
                "method": "GET",
                "path": "api/v4/leads",
            },
            "response": nango_proxy._response_payload(response),
            "outcome": "confirmed",
        }
        exact_cap = len(nango_proxy._dump_json(envelope).encode("utf-8"))
        monkeypatch.setattr(nango_proxy, "MAX_JSON_OUTPUT_BYTES", exact_cap)
        exact_caps.append(exact_cap)
        return response

    _install_mock_transport(monkeypatch, handler)
    _set_call_environment(monkeypatch)

    assert nango_proxy.cmd_call(_parse_call_args("--json-output")) == 0

    output = capsys.readouterr().out
    assert len(output.encode("utf-8")) == exact_caps[0]
    assert json.loads(output)["response"]["body"] == {"ok": True}
