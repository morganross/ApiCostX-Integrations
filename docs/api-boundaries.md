# API boundaries

The Backend API and Allie Owl API must remain separately named in code,
documentation, configuration, and user support.

`api.apicostx.com` is the existing REST resource API. It accepts
`X-ACM2-API-Key` and returns backend resources such as presets, runs, content,
logs, outputs, models, credits, and usage.

`assistant.apicostx.com/owl/v1` is the new conversational entry point. It uses
the OpenAI Chat Completions shape and server-owned Allie Owl actions. The Owl
MCP/SDK/CLI passes the user's API key to Owl, while Owl validates the key and
calls the Backend API on behalf of that user.

The website chatbot is a third system. It uses the logged-in browser session
and page-owned actions. It is not the Owl API and does not use these public
client credentials.
