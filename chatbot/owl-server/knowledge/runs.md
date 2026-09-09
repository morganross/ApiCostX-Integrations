# Runs, logs, and results

Runs belong to the authenticated APICostX user. Use list runs for discovery,
then read one run by ID. Lifecycle states include pending, running, paused,
completed, completed_with_errors, failed, and cancelled.

Lifecycle logs are the safe default. Verbose logs can be large and may contain
user content; request them only when needed and keep the page bounded. Use
generated output reads for report content. Treat provider-reported costs as
exact, estimated, incomplete, or unknown according to the backend response;
never invent a cost.

