"""
Schemas for the private advanced assistant CopilotKit bridge.
"""
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class AdvancedAssistantInternalRunRequest(BaseModel):
    """Minimal AG-UI run input accepted from the CopilotKit runtime."""

    model_config = ConfigDict(extra="allow")

    threadId: str = Field(..., min_length=1)
    runId: str = Field(..., min_length=1)
    parentRunId: Optional[str] = None
    state: Any = Field(default_factory=dict)
    messages: list[dict[str, Any]] = Field(default_factory=list)
    tools: list[dict[str, Any]] = Field(default_factory=list)
    context: list[Any] = Field(default_factory=list)
    forwardedProps: dict[str, Any] = Field(default_factory=dict)
