# Allie open-source LangGraph AG-UI service

This loopback-only FastAPI service runs the unified Allie LangGraph agent without LangGraph Cloud or a licensed LangGraph API server.

It receives chat state and typed frontend tool schemas through AG-UI. It has no ACM backend tools, database credentials, browser session tokens, WordPress credentials, or provider-key disclosure tools.

The service is deployed from live bind-mounted source in a Python 3.12 container. Dependencies live in an ignored `.venv` directory on the host.
