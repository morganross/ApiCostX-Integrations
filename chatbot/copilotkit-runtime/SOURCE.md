# CopilotKit runtime source snapshot

This folder contains the website assistant runtime source and support material.
It is a separate runtime from the standalone Allie Owl API. The runtime must
receive page-owned tools and bounded context; it must not receive browser
session tokens, database keys, provider credentials, or arbitrary backend
authority.

Deployment units, provider-key files, host paths, certificates, and private
operational docs are intentionally excluded from this public snapshot.
