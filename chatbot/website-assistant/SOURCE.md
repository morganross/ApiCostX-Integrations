# Website assistant source snapshot

This folder contains the current website Allie frontend bridge and backend
advanced assistant graph. The browser page owns session authentication and
user data access; the graph receives bounded context and named tool requests.

The files preserve their original application-relative imports and are a public
reference snapshot, not a drop-in npm or Python package. The standalone Owl
API is in `chatbot/owl-server/` and has a separate authority model.
