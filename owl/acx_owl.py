from __future__ import annotations

import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(__file__))
sys.path.insert(0, os.path.join(ROOT, "owl", "python"))
from allie_owl_client import AllieOwl


def main() -> None:
    parser = argparse.ArgumentParser(prog="acx")
    sub = parser.add_subparsers(dest="command", required=True)
    chat = sub.add_parser("chat")
    chat.add_argument("--conversation")
    chat.add_argument("--message")
    chat.add_argument("--json", action="store_true")
    sub.add_parser("models")
    sub.add_parser("conversations")
    usage = sub.add_parser("usage")
    usage.add_argument("--days", type=int, default=30)
    args = parser.parse_args()
    key = os.getenv("APICOSTX_API_KEY", "")
    if not key: parser.error("APICOSTX_API_KEY is required")
    client = AllieOwl(key, os.getenv("ALLIE_OWL_API_URL", "https://assistant.apicostx.com/owl"))
    if args.command == "models": print(json.dumps(client.models(), indent=2)); return
    if args.command == "conversations": print(json.dumps(client.conversations(), indent=2)); return
    if args.command == "usage": print(json.dumps(client.usage(args.days), indent=2)); return
    pending = []
    conversation = args.conversation
    while True:
        text = args.message if args.message is not None else input("you> ").strip()
        if not text: break
        approvals = []
        if pending and text.lower() == '/approve':
            approvals = pending
            text = 'Execute the exact actions I approved.'
        result = client.chat.completions.create(model="allie-owl", messages=[{"role":"user","content":text}], conversation_id=conversation, store=conversation is None, approved_actions=approvals)
        if args.json: print(json.dumps(result, indent=2))
        else: print("allie> " + result["choices"][0]["message"]["content"])
        conversation = result.get("acx_conversation_id", conversation)
        pending = result.get('acx_pending_actions') or []
        if pending and not args.json:
            print(json.dumps(pending, indent=2))
            print('Type /approve to approve these exact actions, or enter another message.')
        if args.message is not None: break


if __name__ == "__main__": main()
