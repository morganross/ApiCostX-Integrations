# Owl security rules

The API key authenticates one APICostX user. Every tool call must use that
identity and must not accept a user UUID, database name, or alternate owner
from the model. Website Allie threads and Owl conversations are different
systems.

Read before changing ambiguous data. Deletes, overwrites, run execution,
pause, resume, cancel, and external publishing require explicit confirmation.
Use idempotency keys for retriable writes. Report downstream authorization,
not-found, validation, timeout, and provider errors as they are returned.

