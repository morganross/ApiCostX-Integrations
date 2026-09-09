from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any, Awaitable, Callable
from jsonschema import Draft202012Validator

from .apicostx import APICostXClient
from .errors import OwlError
from .security import Identity


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[..., Awaitable[Any]]
    write: bool = False


class OwlToolRegistry:
    def __init__(self, client: APICostXClient, store=None):
        self.client = client
        self.store = store
        self._tools = {
            spec.name: spec for spec in (
                ToolSpec("apicostx_list_content", "List the authenticated user's APICostX content library.", {"type":"object","properties":{"page":{"type":"integer","minimum":1},"page_size":{"type":"integer","minimum":1,"maximum":100},"search":{"type":"string","maxLength":200},"content_type":{"type":"string","maxLength":80}},"additionalProperties":False}, self._list_content),
                ToolSpec("apicostx_get_content", "Read one authenticated user's content item.", {"type":"object","properties":{"content_id":{"type":"string","maxLength":255}},"required":["content_id"],"additionalProperties":False}, self._get_content),
                ToolSpec("apicostx_create_content", "Create user-owned APICostX content. Requires explicit confirmation.", {"type":"object","properties":{"confirm":{"type":"boolean"},"name":{"type":"string","maxLength":200},"content_type":{"type":"string","maxLength":80},"body":{"type":"string","maxLength":1000000},"description":{"type":"string","maxLength":1000},"folder_path":{"type":"string","maxLength":500},"tags":{"type":"array","items":{"type":"string","maxLength":100}},"variables":{"type":"object"}},"required":["confirm","name","content_type","body"],"additionalProperties":False}, self._create_content, True),
                ToolSpec("apicostx_update_content", "Update user-owned APICostX content. Requires explicit confirmation.", {"type":"object","properties":{"confirm":{"type":"boolean"},"content_id":{"type":"string","maxLength":255},"patch":{"type":"object"}},"required":["confirm","content_id","patch"],"additionalProperties":False}, self._update_content, True),
                ToolSpec("apicostx_delete_content", "Delete user-owned APICostX content. Requires explicit confirmation.", {"type":"object","properties":{"confirm":{"type":"boolean"},"content_id":{"type":"string","maxLength":255}},"required":["confirm","content_id"],"additionalProperties":False}, self._delete_content, True),
                ToolSpec("apicostx_list_presets", "List the authenticated user's saved presets.", {"type":"object","properties":{"page":{"type":"integer","minimum":1},"page_size":{"type":"integer","minimum":1,"maximum":100}},"additionalProperties":False}, self._list_presets),
                ToolSpec("apicostx_get_preset", "Read one authenticated user's preset.", {"type":"object","properties":{"preset_id":{"type":"string","maxLength":255}},"required":["preset_id"],"additionalProperties":False}, self._get_preset),
                ToolSpec("apicostx_validate_preset", "Check whether an authenticated user's preset is currently runnable.", {"type":"object","properties":{"preset_id":{"type":"string","maxLength":255}},"required":["preset_id"],"additionalProperties":False}, self._validate_preset),
                ToolSpec("apicostx_create_preset", "Create a user-owned APICostX preset from a validated preset payload. Requires explicit confirmation.", {"type":"object","properties":{"confirm":{"type":"boolean"},"preset":{"type":"object"}},"required":["confirm","preset"],"additionalProperties":False}, self._create_preset, True),
                ToolSpec("apicostx_update_preset", "Update a user-owned APICostX preset. Requires explicit confirmation.", {"type":"object","properties":{"confirm":{"type":"boolean"},"preset_id":{"type":"string","maxLength":255},"patch":{"type":"object"}},"required":["confirm","preset_id","patch"],"additionalProperties":False}, self._update_preset, True),
                ToolSpec("apicostx_delete_preset", "Delete a user-owned APICostX preset. Requires explicit confirmation.", {"type":"object","properties":{"confirm":{"type":"boolean"},"preset_id":{"type":"string","maxLength":255}},"required":["confirm","preset_id"],"additionalProperties":False}, self._delete_preset, True),
                ToolSpec("apicostx_execute_preset", "Start an authenticated user's saved preset. Requires read_write API permission and explicit confirmation.", {"type":"object","properties":{"preset_id":{"type":"string","maxLength":255},"confirm":{"type":"boolean"},"idempotency_key":{"type":"string","maxLength":255}},"required":["preset_id","confirm"],"additionalProperties":False}, self._execute_preset, True),
                ToolSpec("apicostx_list_runs", "List the authenticated user's APICostX runs.", {"type":"object","properties":{"page":{"type":"integer","minimum":1},"page_size":{"type":"integer","minimum":1,"maximum":100},"status":{"type":"string","maxLength":40}},"additionalProperties":False}, self._list_runs),
                ToolSpec("apicostx_get_run", "Read one authenticated user's run status and summary.", {"type":"object","properties":{"run_id":{"type":"string","maxLength":255}},"required":["run_id"],"additionalProperties":False}, self._get_run),
                ToolSpec("apicostx_pause_run", "Pause a user-owned APICostX run. Requires explicit confirmation.", {"type":"object","properties":{"confirm":{"type":"boolean"},"run_id":{"type":"string","maxLength":255}},"required":["confirm","run_id"],"additionalProperties":False}, self._pause_run, True),
                ToolSpec("apicostx_resume_run", "Resume a user-owned APICostX run. Requires explicit confirmation.", {"type":"object","properties":{"confirm":{"type":"boolean"},"run_id":{"type":"string","maxLength":255}},"required":["confirm","run_id"],"additionalProperties":False}, self._resume_run, True),
                ToolSpec("apicostx_cancel_run", "Cancel a user-owned APICostX run. Requires explicit confirmation.", {"type":"object","properties":{"confirm":{"type":"boolean"},"run_id":{"type":"string","maxLength":255}},"required":["confirm","run_id"],"additionalProperties":False}, self._cancel_run, True),
                ToolSpec("apicostx_get_run_logs", "Read bounded lifecycle or verbose logs for an authenticated user's run.", {"type":"object","properties":{"run_id":{"type":"string","maxLength":255},"classification":{"type":"string","enum":["event","all"]},"limit":{"type":"integer","minimum":1,"maximum":5000},"offset":{"type":"integer","minimum":0}},"required":["run_id"],"additionalProperties":False}, self._get_run_logs),
                ToolSpec("apicostx_get_generated_output", "Read one generated output from an authenticated user's run.", {"type":"object","properties":{"run_id":{"type":"string","maxLength":255},"doc_id":{"type":"string","maxLength":255}},"required":["run_id","doc_id"],"additionalProperties":False}, self._get_output),
                ToolSpec("apicostx_list_models", "List APICostX models available to the authenticated user.", {"type":"object","properties":{},"additionalProperties":False}, self._list_models),
                ToolSpec("apicostx_get_usage", "Read the authenticated user's coarse assistant usage summary.", {"type":"object","properties":{},"additionalProperties":False}, self._get_usage),
                ToolSpec("apicostx_get_credits", "Read the authenticated user's credit balance and spend summary.", {"type":"object","properties":{},"additionalProperties":False}, self._get_credits),
            )
        }
        extra = (
            ToolSpec('apicostx_duplicate_content', 'Duplicate an existing content item.', {'type':'object','properties':{'content_id':{'type':'string'},'name':{'type':'string'},'confirm':{'type':'boolean'}},'required':['content_id','confirm'],'additionalProperties':False}, self._duplicate_content, True),
            ToolSpec('apicostx_resolve_content', 'Preview content with runtime variables substituted.', {'type':'object','properties':{'content_id':{'type':'string'},'runtime_variables':{'type':'object','additionalProperties':{'type':'string'}}},'required':['content_id'],'additionalProperties':False}, self._resolve_content),
            ToolSpec('apicostx_duplicate_preset', 'Duplicate a saved preset.', {'type':'object','properties':{'preset_id':{'type':'string'},'new_name':{'type':'string'},'confirm':{'type':'boolean'}},'required':['preset_id','new_name','confirm'],'additionalProperties':False}, self._duplicate_preset, True),
            ToolSpec('apicostx_get_resume_info', 'Read run recovery eligibility and checkpoint summary.', {'type':'object','properties':{'run_id':{'type':'string'}},'required':['run_id'],'additionalProperties':False}, self._resume_info),
            ToolSpec('apicostx_get_checkpoint', 'Read run task checkpoint counts.', {'type':'object','properties':{'run_id':{'type':'string'}},'required':['run_id'],'additionalProperties':False}, self._checkpoint),
            ToolSpec('apicostx_delete_run', 'Delete one user-owned run.', {'type':'object','properties':{'run_id':{'type':'string'},'confirm':{'type':'boolean'}},'required':['run_id','confirm'],'additionalProperties':False}, self._delete_run, True),
        )
        self._tools.update({spec.name: spec for spec in extra})
        for name in ('apicostx_get_content', 'apicostx_get_generated_output'):
            self._tools[name].parameters['properties'].update({
                'offset': {'type': 'integer', 'minimum': 0},
                'max_chars': {'type': 'integer', 'minimum': 200, 'maximum': 12000},
            })
        self._tools['apicostx_get_run_logs'].parameters['properties']['limit']['maximum'] = 200
        for spec in self._tools.values():
            if not spec.write:
                spec.parameters['properties'].update({
                    'result_offset': {'type': 'integer', 'minimum': 0},
                    'result_chars': {'type': 'integer', 'minimum': 200, 'maximum': 4000},
                })
        contract_path = Path(__file__).resolve().parents[1] / "contracts" / "actions.json"
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        contract_names = {item["name"] for item in contract.get("actions", [])}
        missing = sorted(set(self._tools) ^ contract_names)
        if missing:
            raise RuntimeError(f"Owl action registry is missing contract entries: {', '.join(missing)}")

    def openai_tools(self) -> list[dict[str, Any]]:
        return [{"type":"function","function":{"name":s.name,"description":s.description,"parameters":s.parameters}} for s in self._tools.values()]

    async def execute(self, name: str, arguments: dict[str, Any], identity: Identity, request_id: str) -> Any:
        spec = self._tools.get(name)
        if spec is None:
            raise OwlError("Unknown Allie Owl tool", 422, "unknown_tool")
        errors = list(Draft202012Validator(spec.parameters).iter_errors(arguments))
        if errors:
            error = errors[0]
            raise OwlError("Invalid tool arguments: " + error.validator, 422, "invalid_tool_arguments", ".".join(map(str, error.path)))
        if spec.write and arguments.get("confirm") is not True:
            raise OwlError("This action requires confirm=true", 400, "confirmation_required")
        try:
            result = await spec.handler(identity, arguments, request_id)
            if not spec.write:
                encoded = json.dumps(result, ensure_ascii=False)
                offset, size = arguments.get('result_offset', 0), arguments.get('result_chars', 4000)
                if len(encoded) > size or offset:
                    return {'result_json_fragment': encoded[offset:offset + size], 'total_result_chars': len(encoded),
                            'next_result_offset': offset + size if offset + size < len(encoded) else None,
                            'read_more': 'Repeat this tool with next_result_offset as result_offset; result is a JSON text fragment, not a complete object.'}
            return result
        except OwlError:
            raise
        except Exception as exc:
            raise OwlError("Allie Owl tool failed", 502, "tool_error") from exc

    async def _list_content(self, i, a, r): return await self.client.list_content(i, a.get("page",1), a.get("page_size",20), a.get("search"), a.get("content_type"), r)
    async def _duplicate_content(self, i, a, r):
        from .apicostx import _id
        return await self.client._request('POST', f'/api/contents/{_id(a["content_id"])}/duplicate', i, params={'name': a['name']} if a.get('name') else {}, request_id=r)
    async def _resolve_content(self, i, a, r):
        from .apicostx import _id
        return await self.client._request('POST', f'/api/contents/{_id(a["content_id"])}/resolve', i, json={'runtime_variables': a.get('runtime_variables', {})}, request_id=r)
    async def _duplicate_preset(self, i, a, r):
        from .apicostx import _id
        return await self.client._request('POST', f'/api/presets/{_id(a["preset_id"])}/duplicate', i, params={'new_name': a['new_name']}, request_id=r)
    async def _resume_info(self, i, a, r):
        from .apicostx import _id
        return await self.client._request('GET', f'/api/runs/{_id(a["run_id"])}/resume-info', i, request_id=r)
    async def _checkpoint(self, i, a, r):
        from .apicostx import _id
        return await self.client._request('GET', f'/api/runs/{_id(a["run_id"])}/checkpoint', i, request_id=r)
    async def _delete_run(self, i, a, r):
        from .apicostx import _id
        return await self.client._request('DELETE', f'/api/runs/{_id(a["run_id"])}', i, request_id=r)
    async def _get_content(self, i, a, r):
        return _page_text(await self.client.get_content(i, a['content_id'], r), 'body', a)
    async def _create_content(self, i, a, r): return await self.client.create_content(i, {k:v for k,v in a.items() if k != "confirm"}, r)
    async def _update_content(self, i, a, r): return await self.client.update_content(i, a["content_id"], a["patch"], r)
    async def _delete_content(self, i, a, r): return await self.client.delete_content(i, a["content_id"], r)
    async def _list_presets(self, i, a, r): return await self.client.list_presets(i, a.get("page",1), a.get("page_size",20), r)
    async def _get_preset(self, i, a, r): return await self.client.get_preset(i, a["preset_id"], r)
    async def _validate_preset(self, i, a, r): return await self.client.validate_preset(i, a["preset_id"], r)
    async def _create_preset(self, i, a, r): return await self.client.create_preset(i, a["preset"], r)
    async def _update_preset(self, i, a, r): return await self.client.update_preset(i, a["preset_id"], a["patch"], r)
    async def _delete_preset(self, i, a, r): return await self.client.delete_preset(i, a["preset_id"], r)
    async def _execute_preset(self, i, a, r):
        import hashlib
        token = a.get('idempotency_key')
        if token and self.store:
            fingerprint = hashlib.sha256(json.dumps({'preset_id': a['preset_id']}, sort_keys=True).encode()).hexdigest()
            replay, result = self.store.reserve_action(i.owner, token, fingerprint)
            if replay:
                return result
        result = await self.client.execute_preset(i, a['preset_id'], r)
        if token and self.store:
            self.store.complete_action(i.owner, token, result)
        return result
    async def _list_runs(self, i, a, r): return await self.client.list_runs(i, a.get("page",1), a.get("page_size",20), a.get("status"), r)
    async def _get_run(self, i, a, r): return await self.client.get_run(i, a["run_id"], r)
    async def _pause_run(self, i, a, r): return await self.client.control_run(i, a["run_id"], "pause", r)
    async def _resume_run(self, i, a, r): return await self.client.control_run(i, a["run_id"], "resume", r)
    async def _cancel_run(self, i, a, r): return await self.client.control_run(i, a["run_id"], "cancel", r)
    async def _get_run_logs(self, i, a, r): return await self.client.get_run_logs(i, a["run_id"], a.get("classification","event"), a.get("limit",100), a.get("offset",0), r)
    async def _get_output(self, i, a, r):
        return _page_text(await self.client.get_output(i, a['run_id'], a['doc_id'], r), 'content', a)
    async def _list_models(self, i, a, r): return await self.client.get_models(i, r)
    async def _get_usage(self, i, a, r): return await self.client.get_usage(i, r)
    async def _get_credits(self, i, a, r): return await self.client.get_credits(i, r)


def _page_text(value, field, arguments):
    text = value.get(field, '')
    if not isinstance(text, str):
        return value
    offset, size = arguments.get('offset', 0), arguments.get('max_chars', 4000)
    return {**value, field: text[offset:offset + size], 'total_chars': len(text),
            'next_offset': offset + size if offset + size < len(text) else None}
