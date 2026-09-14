import os
import logging
import time

from ag_ui_langgraph import LangGraphAgent, add_langgraph_fastapi_endpoint
from copilotkit import CopilotKitMiddleware
from fastapi import FastAPI
from langchain.agents import create_agent
from langchain_core.callbacks import BaseCallbackHandler
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.memory import InMemorySaver


logger = logging.getLogger("uvicorn.error")
logger.setLevel(logging.INFO)


class ModelTimingCallback(BaseCallbackHandler):
    """Log model-stage timings without logging prompts, outputs, or credentials."""

    def __init__(self) -> None:
        self._started: dict[str, float] = {}
        self._first_token: set[str] = set()

    def _start(self, run_id) -> None:
        key = str(run_id)
        if key in self._started:
            return
        self._started[key] = time.perf_counter()
        logger.info("model_call_start run_id=%s", key)

    def on_chat_model_start(self, serialized, messages, *, run_id, **kwargs) -> None:
        self._start(run_id)

    def on_llm_start(self, serialized, prompts, *, run_id, **kwargs) -> None:
        self._start(run_id)

    def on_llm_new_token(self, token, *, run_id, **kwargs) -> None:
        key = str(run_id)
        if key in self._first_token:
            return
        self._first_token.add(key)
        started = self._started.get(key)
        if started is not None:
            logger.info("model_first_token run_id=%s duration_ms=%d", key, round((time.perf_counter() - started) * 1000))

    def on_llm_end(self, response, *, run_id, **kwargs) -> None:
        key = str(run_id)
        started = self._started.pop(key, None)
        self._first_token.discard(key)
        if started is not None:
            logger.info("model_call_end run_id=%s duration_ms=%d", key, round((time.perf_counter() - started) * 1000))

    def on_llm_error(self, error, *, run_id, **kwargs) -> None:
        key = str(run_id)
        started = self._started.pop(key, None)
        self._first_token.discard(key)
        duration_ms = round((time.perf_counter() - started) * 1000) if started is not None else -1
        logger.info("model_call_error run_id=%s duration_ms=%d error_type=%s", key, duration_ms, type(error).__name__)


SYSTEM_PROMPT = """You are Allie, the APICostX website assistant.

Security boundary:
- You have no direct ACM backend, database, WordPress, provider-key, signing-secret, or cross-user authority.
- Frontend tools supplied by the logged-in APICostX page are the only source of private product facts and the only way to change the website.
- Never invent presets, runs, tool results, secrets, account facts, or execution outcomes.
- Never request or expose passwords, browser tokens, database keys, signing secrets, or provider API keys.

Tool policy:
- Prefer the narrowest typed frontend tool.
- For preset planning or diagnosis, call get_preset_page_snapshot once when it is available. Treat its result as the authoritative read-only snapshot for the current turn.
- Do not call the same read-only tool twice with the same arguments in one turn. Do not replace one bounded snapshot with a sequence of overlapping component reads unless the snapshot explicitly reports a missing field.
- Keep canonical reads separate from visible page selection.
- Use select_preset_and_wait_until_hydrated before visible-draft mutation, save, or execution of a saved preset.
- Before paid execution, verify the visible draft is runnable and invoke the page execution tool exactly once.
- Treat the returned run ID as proof that execution started; never invoke execution again for the same user request.
- Use bounded status, log, failure, and output summaries; never request unrestricted raw logs.
- Check a running or pending run at most once per assistant turn. Never poll in a loop or repeatedly call tools to wait; report the pending state and let a later user turn request another check.
- Stop on the first mutation error and explain the returned result.
- The preset generator named OWL is APICostX's separate CAMEL-AI Workforce engine, not the Allie Owl chatbot API. It uses an isolated runtime with DuckDuckGo search only; do not claim browser, shell, or file-writing powers for that engine.
- Engine registration or worker health is not proof of a successful OWL run or useful output. Use live model compatibility, run status, logs, output, and cost evidence; do not claim OWL cancellation works unless the runtime reports it.

Conversation policy:
- Answer normal questions naturally without forcing a tool.
- Use concise deterministic steps for known APICostX workflows.
- Distinguish pending, completed, failed, cancelled, and missing-output states.
- When evidence is incomplete, say what is known and what remains unverified.
"""


model_name = os.getenv("ACM_ALLIE_LANGGRAPH_MODEL", "gpt-5.6-luna").strip() or "gpt-5.6-luna"
reasoning_effort = os.getenv("ACM_ALLIE_REASONING_EFFORT", "medium").strip().lower() or "medium"
if reasoning_effort not in {"none", "low", "medium", "high", "xhigh", "max"}:
    raise RuntimeError(f"Unsupported ACM_ALLIE_REASONING_EFFORT: {reasoning_effort}")

model_timing = ModelTimingCallback()

graph = create_agent(
    model=ChatOpenAI(
        model=model_name,
        api_key=os.environ.get("OPENAI_API_KEY"),
        reasoning_effort=reasoning_effort,
        use_responses_api=True,
        max_retries=2,
        callbacks=[model_timing],
    ),
    tools=[],
    middleware=[CopilotKitMiddleware()],
    system_prompt=SYSTEM_PROMPT,
    checkpointer=InMemorySaver(),
)

app = FastAPI(title="ACM Allie LangGraph Agent", docs_url=None, redoc_url=None)
ag_ui_agent = LangGraphAgent(
    name="allie",
    graph=graph,
    description="APICostX website assistant",
    emit_raw_events=False,
)
add_langgraph_fastapi_endpoint(app=app, agent=ag_ui_agent, path="/")


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "healthy",
        "service": "acm-allie-langgraph-agent",
        "backend_access_enabled": False,
        "model": model_name,
        "reasoning_effort": reasoning_effort,
    }
