# Tool Plan: `get_available_assistant_actions`

Status: planning draft

Purpose:
Give the assistant a compact, trustworthy answer to the question:

"What can I do right here, right now, on this page, with this current assistant state?"

This tool is meant to improve the assistant’s honesty, self-awareness, and UX. Instead of guessing whether save, execute, draft edit, run inspection, or other actions are available, the assistant should be able to ask the frontend explicitly.

## 1. Tool name

`get_available_assistant_actions`

## 2. User-facing purpose

This tool exists so the assistant can explain:

- what it can currently do on the visible page
- what it cannot currently do
- why something is unavailable
- what the user could do to make more actions available

Examples of user questions this tool should help with:

- "What can you do here?"
- "Can you edit this preset right now?"
- "Why can’t you run this preset?"
- "Do I need to open a preset page first?"

## 3. Category

Primary category:

- orientation

Secondary role:

- safety / boundary

## 4. Boundary level

This tool should read only from:

- current visible page context
- assistant-local cache summary
- mounted page bridge availability
- known frontend capability wiring

This tool must not:

- call runtime backend tools
- call ACM BACK directly from runtime
- mutate anything
- silently preload extra data
- infer hidden capabilities that are not actually available

## 5. Inputs

Recommended inputs:

- none

Rationale:

This tool should answer availability for the current page and current assistant/browser state only.

If we later need variants, we can add optional flags like:

- `include_unavailable_reasons: boolean`
- `include_suggested_next_steps: boolean`

But the first version should stay simple.

## 6. Source of truth

The output should be derived from these local facts:

1. Current route/page context
   - route
   - page
   - active preset id
   - current run id

2. Mounted page bridge availability
   - `window.acm2AssistantPresetBridge`

3. Assistant-local cache status
   - whether preset list is loaded
   - whether history rows are loaded
   - whether current preset is cached
   - whether current run is cached

4. Known frontend tool capabilities
   - read-only tools that are always safe
   - mutation tools that require the visible preset page bridge

This tool should not decide availability by broad guesswork. It should be a deterministic view of what is currently true in the browser.

## 7. Output schema

Recommended output shape:

```json
{
  "page_context": {
    "route": "/presets/123",
    "page": "presets",
    "active_preset_id": "123",
    "current_run_id": null,
    "logged_in": true
  },
  "actions": {
    "read_page_state": {
      "available": true
    },
    "load_preset": {
      "available": true
    },
    "read_visible_preset_draft": {
      "available": true
    },
    "edit_visible_preset_draft": {
      "available": true
    },
    "save_visible_preset": {
      "available": true
    },
    "execute_visible_preset": {
      "available": true
    },
    "load_run": {
      "available": false,
      "reason": "No run is selected and no run id was provided yet."
    },
    "load_run_logs": {
      "available": false,
      "reason": "No run is selected and no run id was provided yet."
    },
    "load_run_outputs": {
      "available": false,
      "reason": "No run is selected and no run id was provided yet."
    }
  },
  "suggested_next_steps": [
    "You are on a preset page, so draft inspection and preset save/execute are available.",
    "To inspect a historical run, provide a run id or navigate to a run page."
  ]
}
```

## 8. Semantics

Important meaning rules:

- `available: true` means the assistant may safely use that capability right now.
- `available: false` means the assistant should not act as if it can do it.
- `reason` should explain the immediate blocking condition, not a vague generic message.
- `suggested_next_steps` should be practical and tied to the current page state.

This tool should describe capability, not policy philosophy. Keep the output factual and operational.

Examples:

- "preset page bridge is not mounted"
- "no active preset id is present"
- "run inspection requires a run id or visible run page"

## 9. Allowed LLM interpretation

The assistant may safely infer:

- whether it can or cannot perform a current action
- whether it needs the user to navigate somewhere first
- whether a request must be reframed because the current page does not support it

The assistant should not infer:

- hidden backend powers
- alternate mutation routes
- that unavailable actions can be performed through another mechanism unless another tool explicitly says so

Example allowed explanation:

"I can inspect the visible preset draft and save it from this page, but I cannot inspect a run until we either open one or you provide a run id."

Example disallowed explanation:

"I can probably save it another way behind the scenes."

## 10. Failure and unavailable behavior

This tool should almost never return a hard error.

Preferred behavior:

- Return a normal success payload with accurate availability flags.

Only return an error if:

- the basic assistant page context machinery itself is broken
- a required local dependency is missing in an unexpected way

Do not use hard failure to mean "action not available." Use structured `available: false`.

## 11. Side effects

This tool should be strictly read-only.

It should:

- not mutate page state
- not navigate
- not save
- not execute
- not fetch large remote payloads

## 12. Security / safety review

Why this tool is low-risk:

- it does not expand the assistant boundary
- it improves honesty about current powers
- it reduces the chance of the assistant inventing capabilities
- it supports the page-agent model by making visible-state constraints explicit

Potential risk:

- if implemented sloppily, it could drift into a misleading capabilities registry that claims powers not truly available

Mitigation:

- derive availability from actual page/bridge/cache conditions, not from wishful static declarations alone

## 13. UI / UX expectations

This tool should help the assistant feel more grounded.

Desired user experience:

- when asked "what can you do here?" the answer feels specific to the current page
- when something is blocked, the assistant explains the block cleanly
- when a page is not suitable for a requested action, the assistant can say what page or state it needs

This tool should also reduce frustrating hallucinations where the assistant claims it can save or inspect something that is not actually available.

## 14. Example call

```json
{}
```

## 15. Example success result

```json
{
  "page_context": {
    "route": "/presets/474cb303-0125-4398-9caf-a8c8ad749d33",
    "page": "presets",
    "active_preset_id": "474cb303-0125-4398-9caf-a8c8ad749d33",
    "current_run_id": null,
    "logged_in": true
  },
  "actions": {
    "read_page_state": { "available": true },
    "load_preset": { "available": true },
    "read_visible_preset_draft": { "available": true },
    "edit_visible_preset_draft": { "available": true },
    "save_visible_preset": { "available": true },
    "execute_visible_preset": { "available": true },
    "load_run": { "available": false, "reason": "No run is currently selected." },
    "load_run_logs": { "available": false, "reason": "No run is currently selected." },
    "load_run_outputs": { "available": false, "reason": "No run is currently selected." }
  },
  "suggested_next_steps": [
    "You can inspect, edit, save, or execute the visible preset from this page.",
    "To inspect a run, open a run page or provide a run id."
  ]
}
```

## 16. Example unavailable result

This tool itself should rarely be unavailable, but if local context acquisition breaks badly:

```json
{
  "status": "error",
  "message": "Assistant page context is unavailable."
}
```

## 17. Example explanation behavior

Good explanation:

"Right now I can inspect the current page, load the visible preset, read and edit the mounted preset draft, and save or execute it through the page workflow. I can’t inspect run logs yet because no run is currently selected."

Good follow-up behavior:

"If you want, navigate to a run page or give me a run id and I can inspect that run next."

## 18. Why this tool should be first

This tool is a strong first planning target because:

- it helps every later interaction
- it reduces assistant bluffing
- it makes the boundary visible to users
- it is low-risk and mostly local
- it gives us a pattern for structured capability reporting

## 19. Open questions

1. Should this tool expose only capability booleans, or also confidence / provenance?
2. Should "load_run" be considered available globally if the assistant can accept a run id later, or only when a run context is already present?
3. Should `suggested_next_steps` be generated by code, or should the tool only return facts and let the LLM generate suggestions?

Current recommendation:

- return facts plus very small code-generated suggestions
- keep suggestions deterministic and page-state-based
