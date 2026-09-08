"""Minimal MCP stdio bridge over the standalone Allie Owl API."""
from __future__ import annotations

import json
import os
import sys
import urllib.request


def call_api(path: str, body: dict | None = None, method: str = "POST") -> dict:
    request = urllib.request.Request(os.environ.get("ALLIE_OWL_API_URL", "https://assistant.apicostx.com/owl").rstrip("/") + path, data=(json.dumps(body).encode() if body is not None else None), headers={"Authorization": "Bearer " + os.environ["APICOSTX_API_KEY"], "Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(request, timeout=90) as response: return json.load(response)


TOOLS = [
    {"name":"allie_owl_chat","description":"Have a conversation with the standalone Allie Owl APICostX assistant.","inputSchema":{"type":"object","properties":{"messages":{"type":"array","items":{"type":"object"}},"conversation_id":{"type":"string"},"approved_actions":{"type":"array","items":{"type":"object"}}},"required":["messages"],"additionalProperties":False}},
    {"name":"allie_owl_list_presets","description":"List the authenticated user's APICostX presets.","inputSchema":{"type":"object","properties":{"page":{"type":"integer","minimum":1},"page_size":{"type":"integer","minimum":1,"maximum":100}},"additionalProperties":False}},
]


def respond(message: dict) -> dict | None:
    method = message.get("method")
    request_id = message.get("id")
    if method == "notifications/initialized": return None
    if method == "initialize": return {"jsonrpc":"2.0","id":request_id,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"allie-owl","version":"0.1.0"}}}
    if method == "tools/list":
        try:
            remote = call_api("/v1/tools", method="GET").get("data", [])
            tools = TOOLS[:1] + [{"name": "allie_owl_" + item["function"]["name"], "description": item["function"].get("description", ""), "inputSchema": item["function"].get("parameters", {"type":"object"})} for item in remote]
        except Exception:
            return {"jsonrpc":"2.0","id":request_id,"error":{"code":-32603,"message":"Could not load Allie Owl tools"}}
        return {"jsonrpc":"2.0","id":request_id,"result":{"tools":tools}}
    if method == "tools/call":
        params=message.get("params") or {}
        name = params.get("name")
        if name != "allie_owl_chat" and not (isinstance(name, str) and name.startswith("allie_owl_")):
            return {"jsonrpc":"2.0","id":request_id,"error":{"code":-32601,"message":"Unknown tool"}}
        arguments=params.get("arguments") or {}
        if name == "allie_owl_chat":
            result=call_api("/v1/chat/completions", {"model":"allie-owl","messages":arguments.get("messages") or [],"conversation_id":arguments.get("conversation_id"),"store":not arguments.get("conversation_id"),"approved_actions":arguments.get('approved_actions') or []})
            text=result["choices"][0]["message"]["content"]
        else:
            action = "apicostx_list_presets" if name == "allie_owl_list_presets" else name.removeprefix("allie_owl_")
            result=call_api("/v1/tools/call", {"name":action,"arguments":arguments})
            text=json.dumps(result.get("result"), ensure_ascii=False)
        return {"jsonrpc":"2.0","id":request_id,"result":{"content":[{"type":"text","text":text}],"structuredContent":result}}
    if request_id is not None: return {"jsonrpc":"2.0","id":request_id,"error":{"code":-32601,"message":"Method not found"}}
    return None


def main() -> None:
    for line in sys.stdin:
        message = None
        try:
            message = json.loads(line)
            response=respond(message)
            if response is not None: print(json.dumps(response), flush=True)
        except Exception as exc:
            print(json.dumps({"jsonrpc":"2.0","id":message.get("id") if isinstance(message, dict) else None,"error":{"code":-32603,"message":"Allie Owl MCP request failed"}}), flush=True)


if __name__ == "__main__": main()
