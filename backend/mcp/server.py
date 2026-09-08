"""Small stdio MCP server for the APICostX backend API."""
from __future__ import annotations

import json
import os
import sys

from apicostx import ApiClient


TOOLS = [
    {"name": "apicostx_health", "description": "Read APICostX backend health.", "inputSchema": {"type": "object", "additionalProperties": False}},
    {"name": "apicostx_list_presets", "description": "List the authenticated user's saved presets.", "inputSchema": {"type": "object", "properties": {"page": {"type": "integer", "minimum": 1}, "page_size": {"type": "integer", "minimum": 1, "maximum": 100}}, "additionalProperties": False}},
    {"name": "apicostx_get_preset", "description": "Read one authenticated user's preset.", "inputSchema": {"type": "object", "properties": {"preset_id": {"type": "string"}}, "required": ["preset_id"], "additionalProperties": False}},
    {"name": "apicostx_check_preset", "description": "Check whether a preset is runnable.", "inputSchema": {"type": "object", "properties": {"preset_id": {"type": "string"}}, "required": ["preset_id"], "additionalProperties": False}},
    {"name": "apicostx_execute_preset", "description": "Start a saved preset; requires confirm=true.", "inputSchema": {"type": "object", "properties": {"preset_id": {"type": "string"}, "confirm": {"type": "boolean"}, "input_content_ids": {"type": "array", "items": {"type": "string"}}, "idempotency_key": {"type": "string"}}, "required": ["preset_id", "confirm"], "additionalProperties": False}},
    {"name": "apicostx_list_runs", "description": "List the authenticated user's runs.", "inputSchema": {"type": "object", "properties": {"status": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 500}, "offset": {"type": "integer", "minimum": 0}}, "additionalProperties": False}},
    {"name": "apicostx_get_run", "description": "Read one run.", "inputSchema": {"type": "object", "properties": {"run_id": {"type": "string"}}, "required": ["run_id"], "additionalProperties": False}},
    {"name": "apicostx_get_generated_results", "description": "Read one page of generated results.", "inputSchema": {"type": "object", "properties": {"run_id": {"type": "string"}, "source_doc_id": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}, "offset": {"type": "integer", "minimum": 0}}, "required": ["run_id"], "additionalProperties": False}},
]


def _client() -> ApiClient:
    return ApiClient(api_key=os.getenv("APICOSTX_API_KEY"), base_url=os.getenv("APICOSTX_BASE_URL", "https://api.apicostx.com"))


def _call(name: str, args: dict):
    with _client() as client:
        if name == "apicostx_health": return client.health()
        if name == "apicostx_list_presets": return client.list_presets(page=args.get("page", 1), page_size=args.get("page_size", 100))
        if name == "apicostx_get_preset": return client.get_preset(args["preset_id"])
        if name == "apicostx_check_preset": return client.check_preset(args["preset_id"])
        if name == "apicostx_execute_preset":
            if args.get("confirm") is not True: raise ValueError("confirm=true is required")
            return client.execute_preset(args["preset_id"], input_content_ids=args.get("input_content_ids"), idempotency_key=args.get("idempotency_key"))
        if name == "apicostx_list_runs": return client.list_runs(status=args.get("status"), limit=args.get("limit", 100), offset=args.get("offset", 0))
        if name == "apicostx_get_run": return client.get_run(args["run_id"])
        if name == "apicostx_get_generated_results": return client.get_generated_results(args["run_id"], source_doc_id=args.get("source_doc_id"), limit=args.get("limit", 50), offset=args.get("offset", 0))
        raise ValueError("Unknown APICostX backend tool")


def respond(message: dict) -> dict | None:
    method, request_id = message.get("method"), message.get("id")
    if method == "notifications/initialized": return None
    if method == "initialize": return {"jsonrpc": "2.0", "id": request_id, "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}, "serverInfo": {"name": "apicostx-backend", "version": "0.1.0"}}}
    if method == "tools/list": return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = message.get("params") or {}
        name, args = params.get("name"), params.get("arguments") or {}
        result = _call(name, args)
        return {"jsonrpc": "2.0", "id": request_id, "result": {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}], "structuredContent": result}}
    if request_id is not None: return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}}
    return None


def main() -> None:
    for line in sys.stdin:
        message = None
        try:
            message = json.loads(line)
            response = respond(message)
            if response is not None: print(json.dumps(response), flush=True)
        except Exception:
            print(json.dumps({"jsonrpc": "2.0", "id": message.get("id") if isinstance(message, dict) else None, "error": {"code": -32603, "message": "APICostX backend MCP request failed"}}), flush=True)


if __name__ == "__main__": main()
