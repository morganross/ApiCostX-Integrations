"""Canonical website action metadata shared with the Owl product."""
import json
from pathlib import Path

SHARED_TOOLS = {item['function']['name']: item['function'] for item in json.loads(
    Path(__file__).with_name('tool-schemas.json').read_text(encoding='utf-8'))['tools']}
SHARED_WRITES = {name for name, tool in SHARED_TOOLS.items() if 'confirm' in tool['parameters'].get('required', [])}


def shared_arguments(name, arguments):
    if not isinstance(arguments, dict) or len(json.dumps(arguments)) > 200_000:
        raise ValueError('Invalid shared action arguments')
    tool = SHARED_TOOLS[name]
    allowed = tool['parameters'].get('properties', {})
    if set(arguments) - set(allowed):
        raise ValueError('Unknown shared action argument')
    # The browser confirmation decision supplies this, never the model.
    return {key: value for key, value in arguments.items() if key != 'confirm'}
