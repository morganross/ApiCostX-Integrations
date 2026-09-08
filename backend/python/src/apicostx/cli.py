"""Command-line interface for APICostX."""

from __future__ import annotations

import argparse
import json
import os
import sys
import httpx
from typing import Any

from .client import ApiClient, ApiError


def _json(value: Any) -> None:
    print(json.dumps(value, indent=2, sort_keys=True, default=str))


def _client(args: argparse.Namespace) -> ApiClient:
    return ApiClient(
        api_key=os.getenv("APICOSTX_API_KEY"),
        base_url=args.base_url or os.getenv("APICOSTX_BASE_URL", "https://api.apicostx.com"),
        timeout=args.http_timeout,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="apicostx", description="Run your APICostX presets from a terminal.")
    parser.add_argument("--base-url", help="API origin; defaults to APICOSTX_BASE_URL or https://api.apicostx.com")
    parser.add_argument("--http-timeout", type=float, default=30.0, help="HTTP timeout in seconds")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("health", help="Check API health without authentication")

    presets = sub.add_parser("presets", help="Inspect saved presets")
    presets_sub = presets.add_subparsers(dest="presets_command", required=True)
    list_parser = presets_sub.add_parser("list")
    list_parser.add_argument("--page", type=int, default=1)
    list_parser.add_argument("--page-size", type=int, default=100)
    for name, help_text in (("get", "Load one preset"), ("runnable", "Check whether one preset can run")):
        command = presets_sub.add_parser(name, help=help_text)
        command.add_argument("preset_id")

    run = sub.add_parser("run", help="Start a saved preset")
    run.add_argument("preset_id")
    run.add_argument("--input-content-id", action="append", default=[], help="Input document ID; repeat for multiple inputs")
    run.add_argument("--idempotency-key", help="Stable retry key; prevents duplicate runs")
    run.add_argument("--run-name")
    run.add_argument("--run-description")
    run.add_argument("--iterations", type=int, choices=(1, 2, 3))
    run.add_argument("--eval-iterations", type=int, choices=(1, 2, 3))
    run.add_argument("--wait", action="store_true", help="Wait for the run to reach a terminal state")
    run.add_argument("--timeout", type=float, default=3600.0, help="Maximum wait time in seconds")
    run.add_argument("--poll-interval", type=float, default=2.0, help="Polling interval in seconds")

    runs = sub.add_parser("runs", help="Inspect runs")
    runs_sub = runs.add_subparsers(dest="runs_command", required=True)
    runs_list = runs_sub.add_parser("list")
    runs_list.add_argument("--status")
    runs_list.add_argument("--limit", type=int, default=100)
    runs_list.add_argument("--offset", type=int, default=0)
    for name in ("get", "wait", "results"):
        command = runs_sub.add_parser(name)
        command.add_argument("run_id")
    wait = runs_sub.choices["wait"]
    wait.add_argument("--timeout", type=float, default=3600.0)
    wait.add_argument("--poll-interval", type=float, default=2.0)
    results = runs_sub.choices["results"]
    results.add_argument("--source-doc-id")
    results.add_argument("--limit", type=int, default=50)
    results.add_argument("--offset", type=int, default=0)
    return parser


def run(args: argparse.Namespace) -> int:
    with _client(args) as client:
        if args.command == "health":
            _json(client.health())
        elif args.command == "presets":
            if args.presets_command == "list":
                _json(client.list_presets(page=args.page, page_size=args.page_size))
            elif args.presets_command == "get":
                _json(client.get_preset(args.preset_id))
            else:
                _json(client.check_preset(args.preset_id))
        elif args.command == "run":
            overrides = {
                key: value
                for key, value in {
                    "run_name": args.run_name,
                    "run_description": args.run_description,
                    "iterations": args.iterations,
                    "eval_iterations": args.eval_iterations,
                }.items()
                if value is not None
            }
            result = client.execute_preset(
                args.preset_id,
                input_content_ids=args.input_content_id or None,
                idempotency_key=args.idempotency_key,
                overrides=overrides or None,
            )
            if args.wait and result.get("run_id"):
                print(f"run_id={result['run_id']}", file=sys.stderr)
                result = client.wait_for_run(result["run_id"], timeout=args.timeout, poll_interval=args.poll_interval)
            _json(result)
            if args.wait:
                return 0 if result.get("status") == "completed" else 1
        elif args.command == "runs":
            if args.runs_command == "list":
                _json(client.list_runs(status=args.status, limit=args.limit, offset=args.offset))
            elif args.runs_command == "get":
                _json(client.get_run(args.run_id))
            elif args.runs_command == "wait":
                result = client.wait_for_run(args.run_id, timeout=args.timeout, poll_interval=args.poll_interval)
                _json(result)
                return 0 if result.get("status") == "completed" else 1
            else:
                _json(client.get_generated_results(args.run_id, source_doc_id=args.source_doc_id, limit=args.limit, offset=args.offset))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return run(args)
    except (ApiError, TimeoutError, OSError, httpx.HTTPError) as exc:
        print(f"apicostx: {exc}", file=sys.stderr)
        return 2
