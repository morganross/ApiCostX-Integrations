# Owl server source snapshot

This is the standalone Allie Owl chatbot service source. It is separate from
the website Allie assistant and the APICostX Backend API. The supported public
entry point and installable clients are documented at the repository root;
this source is provided so the chatbot product is inspectable and maintainable.

The service requires environment-provided model and backend credentials. No
credential values belong in this repository. Review [implementation status](implementation-status.md)
and [review fixes](review-fixes.md) before changing deployment behavior.
