"""
API schemas for the advanced assistant scaffold.
"""
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field


class AdvancedAssistantCapabilitiesResponse(BaseModel):
    mode: str = "advanced"
    transport: str = "backend_api"
    scaffolded: bool = True
    streaming: bool = False


class AdvancedAssistantThreadCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(default="New ACM advanced assistant thread", min_length=1, max_length=255)


class AdvancedAssistantThreadUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Optional[str] = Field(default=None, min_length=1, max_length=255)
    archived: Optional[bool] = None


class AdvancedAssistantMessageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(..., min_length=1, max_length=20000)
    page_context: Optional[dict[str, Any]] = None


class AdvancedAssistantToolRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str = "tool_request"
    tool_name: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    requires_confirmation: bool = False
    request_id: str


class AdvancedAssistantToolResultCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str = Field(..., min_length=1, max_length=120)
    tool_name: str = Field(..., min_length=1, max_length=120)
    result: dict[str, Any]
    page_context: Optional[dict[str, Any]] = None


class AdvancedAssistantThreadResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    archived: bool
    created_at: datetime
    updated_at: Optional[datetime] = None


class AdvancedAssistantMessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    thread_id: str
    role: str
    content: str
    created_at: datetime


class AdvancedAssistantThreadListResponse(BaseModel):
    threads: list[AdvancedAssistantThreadResponse]


class AdvancedAssistantThreadDetailResponse(BaseModel):
    thread: AdvancedAssistantThreadResponse
    messages: list[AdvancedAssistantMessageResponse]


class AdvancedAssistantMessagePostResponse(BaseModel):
    thread: AdvancedAssistantThreadResponse
    user_message: AdvancedAssistantMessageResponse
    assistant_message: Optional[AdvancedAssistantMessageResponse] = None
    messages: list[AdvancedAssistantMessageResponse]
    tool_request: Optional[AdvancedAssistantToolRequest] = None


class AdvancedAssistantToolResultPostResponse(BaseModel):
    thread: AdvancedAssistantThreadResponse
    tool_message: AdvancedAssistantMessageResponse
    assistant_message: AdvancedAssistantMessageResponse
    messages: list[AdvancedAssistantMessageResponse]
    tool_request: Optional[AdvancedAssistantToolRequest] = None
