#!/usr/bin/env python3
"""HTTP client for ai-assistant-nango-proxy (OpenClaw → Nango → provider APIs)."""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any
from urllib.parse import urlencode

import httpx

DEFAULT_PROXY_URL = (
    "http://ai-assistant-nango-proxy.ai-assistant-nango-proxy.svc.cluster.local:8080"
)
DEFAULT_TIMEOUT = 300.0


def _resolve_proxy_url(override: str | None) -> str:
    if override and override.strip():
        return override.strip()
    env_val = os.environ.get("NANGO_PROXY_URL", "").strip()
    return env_val or DEFAULT_PROXY_URL


def _required_env(name: str, override: str | None) -> str:
    value = override if override else os.environ.get(name, "")
    if not value.strip():
        raise SystemExit(f"Missing required value: set {name} or pass CLI override")
    return value.strip()


def _parse_headers(raw: list[str]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for item in raw:
        if ":" not in item:
            raise SystemExit(f"Invalid header (expected 'Name: value'): {item!r}")
        name, value = item.split(":", 1)
        headers[name.strip()] = value.strip()
    return headers


def build_url(
    proxy_url: str,
    project_id: str,
    evoclaw_id: str,
    provider: str,
    path: str,
    query: str | None,
) -> str:
    upstream = path.lstrip("/")
    base = proxy_url.rstrip("/")
    url = (
        f"{base}/api/v1/{project_id}/evo-claws/{evoclaw_id}"
        f"/proxy/{provider}/{upstream}"
    )
    if query:
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}{query.lstrip('?')}"
    return url


def cmd_call(args: argparse.Namespace) -> int:
    proxy_url = _resolve_proxy_url(args.proxy_url)
    project_id = _required_env("EVOLUTION_PROJECT_ID", args.project_id)
    evoclaw_id = _required_env("EVOCLAW_ID", args.evoclaw_id)
    api_key = _required_env("CLOUDRU_API_KEY", args.api_key)

    headers = _parse_headers(args.header)
    headers.setdefault("Authorization", f"Api-Key {api_key}")

    content: str | bytes | None = None
    if args.json is not None:
        content = json.dumps(args.json, ensure_ascii=False)
        headers.setdefault("Content-Type", "application/json")
    elif args.body_file:
        with open(args.body_file, "rb") as fh:
            content = fh.read()

    url = build_url(
        proxy_url, project_id, evoclaw_id, args.provider, args.path, args.query
    )

    timeout = httpx.Timeout(args.timeout)
    with httpx.Client(timeout=timeout, follow_redirects=True) as client:
        response = client.request(
            args.method.upper(),
            url,
            headers=headers,
            content=content,
        )

    body_text = response.text
    parsed_json: Any | None = None
    if "application/json" in response.headers.get("content-type", ""):
        try:
            parsed_json = response.json()
        except json.JSONDecodeError:
            parsed_json = None

    if args.json_output:
        envelope = {
            "status_code": response.status_code,
            "url": url,
            "headers": dict(response.headers),
            "body": parsed_json if parsed_json is not None else body_text,
        }
        print(json.dumps(envelope, ensure_ascii=False, indent=2))
    else:
        print(f"HTTP {response.status_code}")
        if parsed_json is not None:
            print(json.dumps(parsed_json, ensure_ascii=False, indent=2))
        else:
            print(body_text)

    return 0 if 200 <= response.status_code < 300 else 1


def cmd_health(args: argparse.Namespace) -> int:
    proxy_url = _resolve_proxy_url(args.proxy_url)
    url = f"{proxy_url.rstrip('/')}/health"
    with httpx.Client(timeout=httpx.Timeout(args.timeout)) as client:
        response = client.get(url)
    print(f"HTTP {response.status_code}")
    print(response.text)
    return 0 if response.status_code == 200 else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Call external APIs via ai-assistant-nango-proxy"
    )
    parser.add_argument(
        "--proxy-url",
        help=f"Override NANGO_PROXY_URL (default env or {DEFAULT_PROXY_URL})",
    )
    parser.add_argument("--project-id", help="Override EVOLUTION_PROJECT_ID")
    parser.add_argument("--evoclaw-id", help="Override EVOCLAW_ID")
    parser.add_argument("--api-key", help="Override CLOUDRU_API_KEY")
    parser.add_argument(
        "--timeout", type=float, default=DEFAULT_TIMEOUT, help="Request timeout seconds"
    )

    sub = parser.add_subparsers(dest="command", required=True)

    call = sub.add_parser("call", help="Proxy a request to a provider API")
    call.add_argument("provider", help="Nango provider_config_key (e.g. yandex)")
    call.add_argument("path", help="Upstream API path (e.g. calendar/v3/events)")
    call.add_argument("--method", default="GET", help="HTTP method")
    call.add_argument("--query", help="Query string (with or without leading ?)")
    call.add_argument(
        "--header", action="append", default=[], help="Extra header 'Name: value'"
    )
    call.add_argument("--json", type=json.loads, help="JSON request body string")
    call.add_argument("--body-file", help="Raw request body from file")
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
