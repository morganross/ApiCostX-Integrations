# Chatbot source

This directory contains the public chatbot source and reference material that
supports the two API integrations in the repository.

## Contents

- `owl-server/` — standalone Allie Owl API implementation, its knowledge pack,
  and its focused documentation/tests
- `website-assistant/frontend/` — website Allie React assistant components,
  authenticated page-action bridge, shared action schemas, and assistant API
  clients
- `website-assistant/backend-graph/` — advanced assistant LangGraph source and
  its API schemas/routes; this is a source snapshot that belongs inside the
  APICostX backend application and is not a standalone service
- `copilotkit-runtime/` — CopilotKit runtime and the LangGraph agent used by the
  website assistant, with public support documentation

The website assistant folder also contains the reviewed assistant knowledge
files, individual tool descriptions, and Allie mascot assets. These are kept
separate from the private infrastructure and operational runbooks that remain
out of the public repository.

The website assistant has page-session authority. The Owl server has its own
API-key boundary. The Backend API remains the resource API. These source areas
are included for transparency and integration development; the public SDKs,
CLIs, and MCP servers at the repository root are the supported downloads.

No production deployment files, private-docs repository, provider credentials,
WordPress secrets, database files, or server environment files are included.
Configuration values in this directory are placeholders or environment names.

The copied website and backend files retain their application-relative imports
and should be updated in their source repositories first when behavior changes.
The `docs/` files in each area describe its source origin and boundary.
