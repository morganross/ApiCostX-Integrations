# APICostX OWL preset engine (CAMEL-AI)

APICostX's preset generator named `OWL` uses CAMEL-AI. It is separate from
Allie Owl, the conversational API described by this service. If a user says
"Owl," use context to tell whether they mean a preset engine or the chatbot;
never conflate their tools, configuration, or capabilities.

The checked-in backend adapter queues a request across a bridge to an isolated
runtime. The deployed runtime inspected on 2026-09-13 had `camel-ai` 0.2.84
installed and implements a CAMEL `Workforce`: task and coordinator agents plus
one or more search workers (`max_agents`). Workers receive DuckDuckGo public
web search through `SearchToolkit`. They are not given browser-control, shell,
or file-writing tools. Attached document text is labeled untrusted reference
material in the task prompt.

Preset OWL settings include selected model(s), temperature, maximum output
tokens, worker count, and timeout. The preset schema allows up to ten workers;
the runtime applies additional input and execution bounds. The runtime source
allows OpenAI, Anthropic, Google/Gemini, and OpenRouter identifiers, but that
is not a promise every model is selectable or configured for every user. The
source model registry checked on 2026-09-13 mapped `openai:gpt-5-mini` to OWL;
use live model and preset tools for current availability.

Before making any provider call, the runtime requires complete APICostX pricing
for the selected model. It also refuses to return a result if provider usage
data is missing or incomplete. Execution is queued and asynchronous; check live
run status, logs, output and cost before saying a run succeeded. Engine
registration or a healthy worker does not prove successful output quality.

The isolated runtime source lives outside the backend checkout. The bridge
health check verifies configured files and paths, not that a real CAMEL run
works. The adapter's `cancel()` currently reports success without stopping
runtime work; do not tell users that cancelling OWL work is verified.
