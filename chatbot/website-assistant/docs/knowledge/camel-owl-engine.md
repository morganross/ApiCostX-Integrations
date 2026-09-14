# CAMEL-AI OWL Engine

## Keep the names separate

The `OWL` option in a preset means APICostX's CAMEL-AI OWL research engine.
It is a generator that contributes work to a preset run. It is not Allie Owl,
the standalone conversational API, and it is not the website assistant.

## What the implementation does

APICostX submits OWL work to an isolated engine worker through a JSON bridge.
The configured external runtime builds a CAMEL-AI `Workforce` with task and
coordinator agents plus a preset-configured number of research workers. The
runtime gives those agents a DuckDuckGo public-web search tool; it does not
install browser-control, shell, or file-writing tools. Supplied document text
is explicitly treated as untrusted reference material.

The current runtime source accepts OpenAI, Anthropic, Google/Gemini, and
OpenRouter provider identifiers. Actual use still depends on the model being
available to the logged-in user or system-key mode, matching runtime/provider
configuration, and complete APICostX pricing. The runtime checks pricing before
provider calls and requires token-usage data to return a metered result. OWL
settings include selected models, temperature, output-token limit, worker
count, and timeout; runtime limits can be stricter than UI values.

## How to advise users

Use OWL when a preset needs its isolated multi-agent, public-web research
workflow. Explain that a selected engine/model and a healthy worker establish
configuration/readiness only; they do not prove a run succeeded or produced a
good report. Use the live preset readiness and model tools before setup advice,
and inspect the run's actual status, output, logs, and cost before describing
an execution. If the user asks about architecture, say the configured CAMEL
runtime is a separately launched Python process behind APICostX's worker
bridge; don't invent details about its host or installation.
