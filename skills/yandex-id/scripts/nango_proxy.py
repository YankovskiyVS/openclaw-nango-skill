#!/usr/bin/env python3
"""HTTP client for ai-assistant-nango-proxy (OpenClaw → Nango → provider APIs)."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sys
from typing import Any
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit

import httpx

DEFAULT_PROXY_URL = (
    "http://ai-assistant-nango-proxy.ai-assistant-nango-proxy.svc.cluster.local:8080"
)
DEFAULT_TIMEOUT = 300.0
MAX_TIMEOUT = 300.0
MAX_API_KEY_FILE_BYTES = 4096
MAX_REQUEST_BODY_BYTES = 1024 * 1024
MAX_RESPONSE_BYTES = 1024 * 1024
MAX_RESPONSE_METADATA_BYTES = 16 * 1024
MAX_CONTENT_TYPE_BYTES = 256
MAX_JSON_OUTPUT_BYTES = 1024 * 1024
MAX_JSON_NESTING_DEPTH = 256
MAX_ROUTING_CHARS = 4096
ALLOWED_METHODS = frozenset(
    {"GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE", "PROPFIND", "REPORT"}
)
READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "PROPFIND", "REPORT"})

CATALOG_PROVIDERS = frozenset(
    {
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
        "yandex",
        "yandex-calendar",
        "yandex-delivery",
        "yandex-direct",
        "yandex-disk",
        "yandex-id",
        "yandex-mail",
        "yandex-maps",
        "yandex-market",
    }
)

_ENCODED_SLASH_RE = re.compile(r"%(?:2f|5c)", re.IGNORECASE)
_PERCENT_ESCAPE_RE = re.compile(r"%[0-9a-fA-F]{2}")
_HTTP_CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
_HEADER_NAME_RE = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")
_BLOCKED_REQUEST_HEADERS = frozenset(
    {
        "api-key",
        "authorization",
        "base-url-override",
        "connection",
        "connection-id",
        "content-length",
        "cookie",
        "decompress",
        "host",
        "keep-alive",
        "proxy-authorization",
        "proxy-connection",
        "provider-config-key",
        "retries",
        "set-cookie",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "x-api-key",
        "x-http-method",
        "x-http-method-override",
        "x-method-override",
    }
)
_BLOCKED_REQUEST_HEADER_PREFIXES = (
    "x-cloud-ru-",
    "x-cloudru-",
    "x-evoclaw-",
    "x-evolution-",
    "x-nango-",
)
_NANGO_PASSTHROUGH_HEADER_PREFIX = "nango-proxy-"
_SAFE_RESPONSE_HEADERS = frozenset(
    {
        "etag",
        "last-modified",
        "link",
        "request-id",
        "retry-after",
        "x-correlation-id",
        "x-next-page",
        "x-page",
        "x-per-page",
        "x-request-id",
        "x-total",
        "x-total-count",
    }
)
_SAFE_RESPONSE_HEADER_PREFIXES = (
    "ratelimit-",
    "x-pagination-",
    "x-ratelimit-",
)
_SAFE_UPSTREAM_LAYERS = frozenset({"cloudru_proxy", "nango", "provider"})
_SAFE_UPSTREAM_CODES = frozenset(
    {
        "authentication_failed",
        "connection_not_found",
        "forbidden",
        "invalid_connection",
        "not_found",
        "provider_error",
        "rate_limited",
        "upstream_timeout",
        "upstream_unavailable",
    }
)
class JsonNestingError(ValueError):
    """Raised when JSON exceeds the portable nesting budget."""


_JSON_RESOURCE_ERRORS = (
    JsonNestingError,
    RecursionError,
    MemoryError,
    OverflowError,
)
_JSON_PARSE_ERRORS = (
    json.JSONDecodeError,
    UnicodeDecodeError,
) + _JSON_RESOURCE_ERRORS


def _load_json_with_depth_limit(
    source: str | bytes | bytearray,
) -> Any:
    if isinstance(source, str):
        scan_source = source
    else:
        encoded_source = bytes(source)
        scan_source = encoded_source.decode(
            json.detect_encoding(encoded_source),
            "surrogatepass",
        )
    depth = 0
    in_string = False
    escaped = False

    for token in scan_source:
        if in_string:
            if escaped:
                escaped = False
            elif token == "\\":
                escaped = True
            elif token == '"':
                in_string = False
            continue

        if token == '"':
            in_string = True
        elif token in ("[", "{"):
            depth += 1
            if depth > MAX_JSON_NESTING_DEPTH:
                raise JsonNestingError("JSON nesting depth exceeds the limit")
        elif token in ("]", "}") and depth:
            depth -= 1

    return json.loads(source)


class ApiKeyFileError(Exception):
    """Raised when a CLI credential file cannot be read."""


def _resolve_proxy_url(override: str | None) -> str:
    if override and override.strip():
        return override.strip()
    env_val = os.environ.get("NANGO_PROXY_URL", "").strip()
    return env_val or DEFAULT_PROXY_URL


def _required_env(name: str, override: str | None) -> str:
    value = override if override else os.environ.get(name, "")
    if not value.strip():
        raise ValueError(f"Missing required value: {name}")
    return value.strip()


def _validated_api_key(value: str) -> str:
    api_key = value.strip()
    if (
        not api_key
        or _HTTP_CONTROL_RE.search(api_key) is not None
        or len(api_key.encode("utf-8")) > MAX_API_KEY_FILE_BYTES
    ):
        raise ValueError("API key is invalid")
    return api_key


def _resolve_api_key(
    api_key_file: str | None,
    legacy_override: str | None,
) -> str:
    if api_key_file is not None and legacy_override is not None:
        raise ValueError("--api-key-file and --api-key cannot be combined")
    if legacy_override is not None:
        print(
            "warning: --api-key is deprecated; use CLOUDRU_API_KEY "
            "or --api-key-file",
            file=sys.stderr,
        )
        return _validated_api_key(legacy_override)
    if api_key_file is None:
        return _validated_api_key(_required_env("CLOUDRU_API_KEY", None))

    try:
        with open(api_key_file, "rb") as key_stream:
            raw_key = key_stream.read(MAX_API_KEY_FILE_BYTES + 1)
    except OSError as exc:
        raise ApiKeyFileError from exc
    if len(raw_key) > MAX_API_KEY_FILE_BYTES:
        raise ValueError("API key file exceeds the size limit")
    try:
        api_key = raw_key.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("API key file is not UTF-8") from exc
    return _validated_api_key(api_key)


def _is_blocked_request_header(normalized_name: str) -> bool:
    effective_name = normalized_name
    while effective_name.startswith(_NANGO_PASSTHROUGH_HEADER_PREFIX):
        effective_name = effective_name[len(_NANGO_PASSTHROUGH_HEADER_PREFIX) :]
        if not effective_name:
            return True
    return effective_name in _BLOCKED_REQUEST_HEADERS or effective_name.startswith(
        _BLOCKED_REQUEST_HEADER_PREFIXES
    )


def _parse_headers(raw: list[str]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for item in raw:
        if "\r" in item or "\n" in item:
            raise ValueError("Header names and values must not contain line breaks")
        if ":" not in item:
            raise ValueError("Invalid header: expected 'Name: value'")
        name, value = item.split(":", 1)
        name = name.strip()
        if _HEADER_NAME_RE.fullmatch(name) is None:
            raise ValueError("Invalid header name")
        normalized_name = name.lower()
        if _is_blocked_request_header(normalized_name):
            raise ValueError("Header is not allowed for provider requests")
        value = value.strip()
        try:
            value.encode("ascii")
        except UnicodeEncodeError as exc:
            raise ValueError("Header value must use ASCII") from exc
        headers[name] = value
    return headers


def _set_default_header(headers: dict[str, str], name: str, value: str) -> None:
    if not any(existing.lower() == name.lower() for existing in headers):
        headers[name] = value


def _build_body(
    *,
    json_body: Any | None,
    json_supplied: bool | None = None,
    text_body: str | None,
    body_file: str | None,
    headers: dict[str, str],
) -> bytes | None:
    has_json_body = json_body is not None if json_supplied is None else json_supplied
    selected_modes = sum(
        (has_json_body, text_body is not None, body_file is not None)
    )
    if selected_modes > 1:
        raise ValueError("Select exactly one of JSON, text or file body")

    content: bytes | None
    default_content_type: str | None = None
    if has_json_body:
        content = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        default_content_type = "application/json"
    elif text_body is not None:
        content = text_body.encode("utf-8")
        default_content_type = "text/plain; charset=utf-8"
    elif body_file is not None:
        with open(body_file, "rb") as body_stream:
            content = body_stream.read(MAX_REQUEST_BODY_BYTES + 1)
    else:
        return None

    if len(content) > MAX_REQUEST_BODY_BYTES:
        raise ValueError("Request body exceeds the size limit")
    if default_content_type is not None:
        _set_default_header(headers, "Content-Type", default_content_type)
    return content


def _safe_response_headers(headers: httpx.Headers) -> dict[str, str]:
    safe_headers: dict[str, str] = {}
    metadata_size = 0
    for name, value in headers.items():
        normalized_name = name.lower()
        encoded_size = len(normalized_name.encode("utf-8")) + len(
            value.encode("utf-8")
        )
        if not (
            normalized_name in _SAFE_RESPONSE_HEADERS
            or normalized_name.startswith(_SAFE_RESPONSE_HEADER_PREFIXES)
        ):
            continue
        if (
            "\r" in value
            or "\n" in value
            or encoded_size > MAX_RESPONSE_METADATA_BYTES
            or metadata_size + encoded_size > MAX_RESPONSE_METADATA_BYTES
        ):
            continue
        safe_headers[normalized_name] = value
        metadata_size += encoded_size
    return safe_headers


def _content_type(response: httpx.Response) -> str:
    content_type = response.headers.get("content-type", "").strip()
    if (
        "\r" in content_type
        or "\n" in content_type
        or len(content_type.encode("utf-8")) > MAX_CONTENT_TYPE_BYTES
    ):
        return ""
    return content_type


def _response_has_body(response: httpx.Response) -> bool:
    return (
        response.request.method.upper() != "HEAD"
        and response.status_code not in {204, 304}
        and not 100 <= response.status_code < 200
    )


def _declared_response_size(response: httpx.Response) -> int | None:
    if not _response_has_body(response):
        return 0
    raw_size = response.headers.get("content-length")
    if raw_size is None or not raw_size.isascii() or not raw_size.isdecimal():
        return None
    try:
        return int(raw_size)
    except (ValueError, OverflowError):
        return None


def _read_bounded_response(response: httpx.Response) -> httpx.Response | None:
    declared_size = _declared_response_size(response)
    if declared_size is not None and declared_size > MAX_RESPONSE_BYTES:
        return None

    content = bytearray()
    for chunk in response.iter_bytes():
        remaining = MAX_RESPONSE_BYTES + 1 - len(content)
        content.extend(chunk[:remaining])
        if len(content) > MAX_RESPONSE_BYTES:
            return None

    return httpx.Response(
        response.status_code,
        headers=response.headers,
        content=bytes(content),
        request=response.request,
        extensions=response.extensions,
    )


def _response_body(response: httpx.Response) -> Any:
    content = response.content
    content_type = _content_type(response)
    media_type = content_type.partition(";")[0].strip().lower()
    is_json = media_type == "application/json" or media_type.endswith("+json")
    is_text = (
        not media_type
        or media_type.startswith("text/")
        or media_type in {"application/javascript", "application/xml"}
        or media_type.endswith("+xml")
    )

    if is_json:
        if len(content) > MAX_RESPONSE_BYTES:
            return {
                "kind": "json",
                "size": len(content),
                "contentType": content_type,
                "sha256": hashlib.sha256(content).hexdigest(),
                "truncated": True,
            }
        try:
            return _load_json_with_depth_limit(content)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return content.decode("utf-8", errors="replace")

    if is_text:
        if len(content) <= MAX_RESPONSE_BYTES:
            return content.decode("utf-8", errors="replace")
        return {
            "kind": "text",
            "size": len(content),
            "text": content[:MAX_RESPONSE_BYTES].decode(
                "utf-8", errors="replace"
            ),
            "truncated": True,
        }

    return {
        "kind": "binary",
        "size": len(content),
        "contentType": content_type or "application/octet-stream",
        "sha256": hashlib.sha256(content).hexdigest(),
    }


def _response_payload(response: httpx.Response) -> dict[str, Any]:
    return {
        "status": response.status_code,
        "contentType": _content_type(response),
        "headers": _safe_response_headers(response.headers),
        "body": _response_body(response),
    }


def _request_summary(args: argparse.Namespace) -> dict[str, str]:
    method = args.method.upper() if isinstance(args.method, str) else "<invalid>"
    return {
        "providerConfigKey": args.provider,
        "method": method,
        "path": args.path,
    }


def _dump_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _bounded_utf8(value: str, max_bytes: int) -> str:
    encoded = value.encode("utf-8", errors="replace")
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def _emit_plain_response(status: int, body: Any) -> None:
    body_text = _dump_json(body) if isinstance(body, (dict, list)) else str(body)
    output = f"HTTP {status}\n{body_text}\n"
    sys.stdout.write(_bounded_utf8(output, MAX_RESPONSE_BYTES))


def _summarized_response_body(response: httpx.Response) -> dict[str, Any]:
    content_type = _content_type(response)
    media_type = content_type.partition(";")[0].strip().lower()
    kind = (
        "json"
        if media_type == "application/json" or media_type.endswith("+json")
        else "text"
        if not media_type or media_type.startswith("text/")
        else "binary"
    )
    return {
        "kind": kind,
        "size": len(response.content),
        "contentType": content_type or "application/octet-stream",
        "sha256": hashlib.sha256(response.content).hexdigest(),
        "truncated": True,
    }


def _bounded_success_json(
    envelope: dict[str, Any],
    response: httpx.Response,
) -> str:
    serialized = _dump_json(envelope)
    if len(serialized.encode("utf-8")) <= MAX_JSON_OUTPUT_BYTES:
        return serialized

    bounded_response = dict(envelope["response"])
    bounded_response["headers"] = {}
    bounded_response["body"] = _summarized_response_body(response)
    bounded_envelope = dict(envelope)
    bounded_envelope["response"] = bounded_response
    return _dump_json(bounded_envelope)


def _failure_envelope(
    request: dict[str, str],
    *,
    layer: str,
    code: str,
    message: str,
    retryable: bool,
    outcome: str,
    status: int | None = None,
) -> dict[str, Any]:
    error: dict[str, Any] = {
        "layer": layer,
        "code": code,
        "message": message,
    }
    if status is not None:
        error["status"] = status
    error["retryable"] = retryable
    return {
        "ok": False,
        "request": request,
        "error": error,
        "outcome": outcome,
    }


def _emit_failure(
    args: argparse.Namespace,
    request: dict[str, str],
    *,
    layer: str,
    code: str,
    message: str,
    retryable: bool,
    outcome: str,
    status: int | None = None,
    exit_code: int = 1,
) -> int:
    safe_request = (
        {
            "providerConfigKey": "<invalid>",
            "method": "<invalid>",
            "path": "<invalid>",
        }
        if outcome == "not_started"
        else request
    )
    envelope = _failure_envelope(
        safe_request,
        layer=layer,
        code=code,
        message=message,
        retryable=retryable,
        outcome=outcome,
        status=status,
    )
    if getattr(args, "json_output", False):
        print(_dump_json(envelope))
    else:
        status_text = f" (HTTP {status})" if status is not None else ""
        print(f"ERROR {layer}/{code}{status_text}: {message}")
    return exit_code


def _emit_invalid_response(
    args: argparse.Namespace,
    request: dict[str, str],
    response: httpx.Response,
) -> int:
    return _emit_failure(
        args,
        request,
        layer="unknown_upstream",
        code="invalid_response",
        message="Upstream response could not be parsed",
        status=response.status_code,
        retryable=False,
        outcome="confirmed_failed",
    )


def _explicit_upstream_error(response: httpx.Response) -> tuple[str, str]:
    layer = "unknown_upstream"
    code = "upstream_http_error"
    content_type = _content_type(response).partition(";")[0].strip().lower()
    if not (
        content_type == "application/json" or content_type.endswith("+json")
    ) or len(response.content) > MAX_RESPONSE_BYTES:
        return layer, code
    try:
        payload = _load_json_with_depth_limit(response.content)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return layer, code
    if not isinstance(payload, dict):
        return layer, code

    metadata = payload.get("proxyError")
    if not isinstance(metadata, dict) or not (
        type(metadata.get("schemaVersion")) is int
        and metadata.get("schemaVersion") == 1
    ):
        return layer, code
    candidate_layer = metadata.get("layer")
    candidate_code = metadata.get("code")
    if (
        isinstance(candidate_layer, str)
        and candidate_layer in _SAFE_UPSTREAM_LAYERS
        and isinstance(candidate_code, str)
        and candidate_code in _SAFE_UPSTREAM_CODES
    ):
        return candidate_layer, candidate_code
    return layer, code


def _validated_timeout(value: float | str) -> httpx.Timeout:
    try:
        timeout_value = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("Timeout is invalid") from exc
    if (
        not math.isfinite(timeout_value)
        or timeout_value <= 0
        or timeout_value > MAX_TIMEOUT
    ):
        raise ValueError("Timeout is outside the allowed range")
    return httpx.Timeout(timeout_value)


def _validated_method(method: str) -> str:
    if not isinstance(method, str):
        raise ValueError("HTTP method is invalid")
    normalized_method = method.upper()
    if normalized_method not in ALLOWED_METHODS:
        raise ValueError("HTTP method is invalid")
    return normalized_method


def _validate_percent_encoding(value: str, label: str) -> None:
    index = 0
    while True:
        index = value.find("%", index)
        if index < 0:
            return
        if _PERCENT_ESCAPE_RE.match(value, index) is None:
            raise ValueError(f"{label} contains an invalid percent escape")
        index += 3


def _validated_proxy_base(proxy_url: str) -> str:
    if "\r" in proxy_url or "\n" in proxy_url:
        raise ValueError("Proxy URL contains a line break")
    try:
        parsed = urlsplit(proxy_url)
        parsed_port = parsed.port
    except ValueError as exc:
        raise ValueError("Proxy URL is invalid") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Proxy URL must use http or https and include a host")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Proxy URL must not contain credentials")
    if parsed.query or parsed.fragment:
        raise ValueError("Proxy URL must not contain a query or fragment")
    if parsed_port is not None and not 1 <= parsed_port <= 65535:
        raise ValueError("Proxy URL port is invalid")
    return proxy_url.rstrip("/")


def _validated_provider_path(path: str) -> str:
    if (
        not path
        or len(path) > MAX_ROUTING_CHARS
        or path.startswith("/")
        or "\\" in path
    ):
        raise ValueError("Provider path must be a non-empty relative path")
    _validate_percent_encoding(path, "Provider path")
    if _ENCODED_SLASH_RE.search(path):
        raise ValueError("Provider path must not contain an encoded slash")

    parsed = urlsplit(path)
    if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError("Provider path must not be an absolute URL, query or fragment")

    raw_segments = path.split("/")
    has_trailing_slash = raw_segments[-1] == ""
    if has_trailing_slash:
        raw_segments = raw_segments[:-1]
    decoded_segments = [unquote(segment) for segment in raw_segments]
    if any(segment in {"", ".", ".."} for segment in decoded_segments):
        raise ValueError("Provider path contains an unsafe segment")
    if any("/" in segment or "\\" in segment for segment in decoded_segments):
        raise ValueError("Provider path contains an encoded slash")
    normalized_path = "/".join(
        quote(segment, safe="-._~") for segment in decoded_segments
    )
    return f"{normalized_path}/" if has_trailing_slash else normalized_path


def _validated_query(query: str | None) -> str:
    if not query:
        return ""
    raw_query = query[1:] if query.startswith("?") else query
    if (
        len(raw_query) > MAX_ROUTING_CHARS
        or "#" in raw_query
        or "\r" in raw_query
        or "\n" in raw_query
    ):
        raise ValueError("Query contains a fragment or line break")
    _validate_percent_encoding(raw_query, "Query")
    return urlencode(parse_qsl(raw_query, keep_blank_values=True), doseq=True)


def build_url(
    proxy_url: str,
    project_id: str,
    evoclaw_id: str,
    provider: str,
    path: str,
    query: str | None,
) -> str:
    if provider not in CATALOG_PROVIDERS:
        raise ValueError("Provider is not present in the catalog")
    if not project_id or not evoclaw_id:
        raise ValueError("Project and EvoClaw identifiers are required")

    upstream = _validated_provider_path(path)
    base = _validated_proxy_base(proxy_url)
    url = (
        f"{base}/api/v1/{quote(project_id, safe='')}"
        f"/evo-claws/{quote(evoclaw_id, safe='')}"
        f"/proxy/{quote(provider, safe='')}/{upstream}"
    )
    normalized_query = _validated_query(query)
    if normalized_query:
        url = f"{url}?{normalized_query}"
    return url


def cmd_call(args: argparse.Namespace) -> int:
    request = _request_summary(args)
    method = ""
    is_mutation = True

    try:
        method = _validated_method(args.method)
        is_mutation = method not in READ_METHODS
        request["method"] = method

        json_body = args.json
        json_supplied = json_body is not None
        if json_supplied and isinstance(json_body, str):
            try:
                json_body = _load_json_with_depth_limit(json_body)
            except _JSON_PARSE_ERRORS as exc:
                raise ValueError("JSON body is invalid") from exc

        proxy_url = _resolve_proxy_url(args.proxy_url)
        project_id = _required_env("EVOLUTION_PROJECT_ID", args.project_id)
        evoclaw_id = _required_env("EVOCLAW_ID", args.evoclaw_id)
        api_key = _resolve_api_key(args.api_key_file, args.api_key)

        headers = _parse_headers(args.header)
        headers["Authorization"] = f"Api-Key {api_key}"
        content = _build_body(
            json_body=json_body,
            json_supplied=json_supplied,
            text_body=args.text,
            body_file=args.body_file,
            headers=headers,
        )
        url = build_url(
            proxy_url, project_id, evoclaw_id, args.provider, args.path, args.query
        )
        timeout = _validated_timeout(args.timeout)
    except ApiKeyFileError:
        return _emit_failure(
            args,
            request,
            layer="local_io",
            code="api_key_file_error",
            message="API key file could not be read",
            retryable=False,
            outcome="not_started",
            exit_code=2,
        )
    except OSError:
        return _emit_failure(
            args,
            request,
            layer="local_io",
            code="body_file_error",
            message="Request body file could not be read",
            retryable=False,
            outcome="not_started",
            exit_code=2,
        )
    except (TypeError, ValueError, RecursionError, MemoryError, OverflowError):
        return _emit_failure(
            args,
            request,
            layer="validation",
            code="invalid_request",
            message="Request validation failed",
            retryable=False,
            outcome="not_started",
            exit_code=2,
        )

    try:
        with httpx.Client(timeout=timeout, follow_redirects=False) as client:
            with client.stream(
                method,
                url,
                headers=headers,
                content=content,
            ) as streamed_response:
                response = _read_bounded_response(streamed_response)
    except httpx.TimeoutException as exc:
        dispatched = not isinstance(exc, (httpx.ConnectTimeout, httpx.PoolTimeout))
        if is_mutation and dispatched:
            return _emit_failure(
                args,
                request,
                layer="network",
                code="mutation_timeout",
                message=(
                    "Mutation timed out after dispatch; verify state before retrying"
                ),
                retryable=False,
                outcome="unknown",
            )
        return _emit_failure(
            args,
            request,
            layer="network",
            code="network_timeout",
            message="Network request timed out",
            retryable=not is_mutation,
            outcome="not_started",
        )
    except httpx.RequestError as exc:
        dispatched = not isinstance(exc, httpx.ConnectError)
        if is_mutation and dispatched:
            return _emit_failure(
                args,
                request,
                layer="network",
                code="mutation_network_error",
                message="Mutation transport failed after dispatch; verify remote state",
                retryable=False,
                outcome="unknown",
            )
        return _emit_failure(
            args,
            request,
            layer="network",
            code="network_error",
            message="Network request failed",
            retryable=not is_mutation,
            outcome="not_started",
        )

    succeeded = 200 <= streamed_response.status_code < 300
    if not succeeded:
        if streamed_response.has_redirect_location:
            return _emit_failure(
                args,
                request,
                layer="unknown_upstream",
                code="redirect_blocked",
                message="Credentialed redirect was blocked",
                status=streamed_response.status_code,
                retryable=False,
                outcome="confirmed_failed",
            )
        if response is None:
            layer, code = "unknown_upstream", "upstream_http_error"
        else:
            try:
                layer, code = _explicit_upstream_error(response)
            except _JSON_RESOURCE_ERRORS:
                return _emit_invalid_response(args, request, response)
        retryable = not is_mutation and (
            streamed_response.status_code in {408, 429}
            or streamed_response.status_code >= 500
        )
        return _emit_failure(
            args,
            request,
            layer=layer,
            code=code,
            message="Upstream request failed",
            status=streamed_response.status_code,
            retryable=retryable,
            outcome="confirmed_failed",
        )

    if response is None:
        return _emit_invalid_response(args, request, streamed_response)

    try:
        response_payload = _response_payload(response)
    except _JSON_RESOURCE_ERRORS:
        return _emit_invalid_response(args, request, response)
    if args.json_output:
        envelope = {
            "ok": True,
            "request": request,
            "response": response_payload,
            "outcome": "confirmed",
        }
        serialized = _bounded_success_json(envelope, response)
        terminator = (
            "\n"
            if len(serialized.encode("utf-8")) < MAX_JSON_OUTPUT_BYTES
            else ""
        )
        sys.stdout.write(f"{serialized}{terminator}")
    else:
        _emit_plain_response(response.status_code, response_payload["body"])

    return 0


def cmd_health(args: argparse.Namespace) -> int:
    try:
        proxy_url = _validated_proxy_base(_resolve_proxy_url(args.proxy_url))
        timeout = _validated_timeout(args.timeout)
    except (TypeError, ValueError):
        print("ERROR validation/invalid_request: Health request validation failed")
        return 2

    url = f"{proxy_url}/health"
    try:
        with httpx.Client(timeout=timeout, follow_redirects=False) as client:
            with client.stream("GET", url) as streamed_response:
                response = _read_bounded_response(streamed_response)
    except httpx.RequestError:
        print("ERROR network/network_error: Health request failed")
        return 1

    if response is None:
        print("ERROR unknown_upstream/invalid_response: Health response is invalid")
        return 1

    try:
        response_payload = _response_payload(response)
        _emit_plain_response(response.status_code, response_payload["body"])
    except _JSON_RESOURCE_ERRORS:
        print("ERROR unknown_upstream/invalid_response: Health response is invalid")
        return 1
    return 0 if response.status_code == 200 else 1


def _add_common_options(
    parser: argparse.ArgumentParser,
    *,
    suppress_defaults: bool,
) -> None:
    default = argparse.SUPPRESS if suppress_defaults else None
    timeout_default: float | str = (
        argparse.SUPPRESS if suppress_defaults else DEFAULT_TIMEOUT
    )
    parser.add_argument(
        "--proxy-url",
        default=default,
        help=f"Override NANGO_PROXY_URL (default env or {DEFAULT_PROXY_URL})",
    )
    parser.add_argument(
        "--project-id",
        default=default,
        help="Override EVOLUTION_PROJECT_ID",
    )
    parser.add_argument(
        "--evoclaw-id",
        default=default,
        help="Override EVOCLAW_ID",
    )
    credentials = parser.add_mutually_exclusive_group()
    credentials.add_argument(
        "--api-key-file",
        default=default,
        help="Read a CLOUDRU_API_KEY override from a UTF-8 file",
    )
    credentials.add_argument(
        "--api-key",
        default=default,
        help=argparse.SUPPRESS,
    )
    parser.add_argument(
        "--timeout",
        default=timeout_default,
        help="Request timeout seconds",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Call external APIs via ai-assistant-nango-proxy",
        allow_abbrev=False,
    )
    _add_common_options(parser, suppress_defaults=False)

    sub = parser.add_subparsers(dest="command", required=True)

    call = sub.add_parser(
        "call",
        help="Proxy a request to a provider API",
        allow_abbrev=False,
    )
    _add_common_options(call, suppress_defaults=True)
    call.add_argument("provider", help="Nango provider_config_key (e.g. yandex)")
    call.add_argument("path", help="Upstream API path (e.g. calendar/v3/events)")
    call.add_argument("--method", default="GET", help="HTTP method")
    call.add_argument("--query", help="Query string (with or without leading ?)")
    call.add_argument(
        "--header", action="append", default=[], help="Extra header 'Name: value'"
    )
    body = call.add_mutually_exclusive_group()
    body.add_argument("--json", help="JSON request body string")
    body.add_argument("--text", help="UTF-8 text request body")
    body.add_argument("--body-file", help="Raw request body from file")
    call.add_argument(
        "--json-output",
        action="store_true",
        help="Print status + parsed body as JSON envelope",
    )
    call.set_defaults(func=cmd_call)

    health = sub.add_parser("health", help="GET /health on the proxy")
    health.set_defaults(func=cmd_health)

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    raise SystemExit(args.func(args))


if __name__ == "__main__":
    main()
