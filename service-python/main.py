"""Internal AI service. Only api-node calls it, over the compose network.

Stateless: api-node sends the Anthropic API key (X-Anthropic-Api-Key) and,
for generation calls, the model with every request, so an admin can change
either from the dashboard without restarting this service.
"""

import json
import logging

import anthropic
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from embed import DIMENSIONS, MODEL_NAME, embed
from extract import MAX_MESSAGE_CHARS, extract_order

log = logging.getLogger("ai")
logging.basicConfig(level=logging.INFO, format="%(message)s")

app = FastAPI(title="logistics-service-python")


def client_for(api_key: str | None, timeout: float = 15.0) -> anthropic.AsyncAnthropic:
    if not api_key:
        raise HTTPException(400, {"code": "no_key", "message": "No Anthropic API key was sent"})
    # Short timeouts and one retry: these calls sit behind a dashboard button.
    return anthropic.AsyncAnthropic(api_key=api_key, timeout=timeout, max_retries=1)


def api_error(err: Exception) -> HTTPException:
    """Turn SDK errors into messages a dispatcher or admin can act on."""
    if isinstance(err, anthropic.AuthenticationError):
        return HTTPException(400, {"code": "invalid_key", "message": "Anthropic rejected this API key. Check it was copied in full and has not been revoked."})
    if isinstance(err, anthropic.PermissionDeniedError):
        return HTTPException(400, {"code": "permission", "message": "This API key is not allowed to do that. Check the key's workspace permissions in the Claude Console."})
    if isinstance(err, anthropic.RateLimitError):
        return HTTPException(429, {"code": "rate_limited", "message": "Anthropic is rate limiting this key. Try again in a minute."})
    if isinstance(err, anthropic.APIStatusError):
        if err.status_code >= 500:
            return HTTPException(502, {"code": "upstream", "message": "Anthropic had a server error. Try again shortly."})
        return HTTPException(400, {"code": "api_error", "message": err.message})
    if isinstance(err, anthropic.APIConnectionError):
        return HTTPException(502, {"code": "network", "message": "Could not reach Anthropic from the server. Check its internet connection."})
    return HTTPException(500, {"code": "internal", "message": "The AI service failed"})


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/ai/models")
async def list_models(x_anthropic_api_key: str | None = Header(default=None)):
    """Validates the key and returns the models it can use."""
    client = client_for(x_anthropic_api_key)
    try:
        models = [m async for m in client.models.list()]
    except anthropic.AnthropicError as err:
        raise api_error(err) from err
    return {
        "ok": True,
        "models": [
            {
                "id": m.id,
                "display_name": m.display_name,
                "created_at": m.created_at.isoformat() if m.created_at else None,
                "max_input_tokens": getattr(m, "max_input_tokens", None),
                "max_tokens": getattr(m, "max_tokens", None),
            }
            for m in models
        ],
    }


class ExtractRequest(BaseModel):
    model: str = Field(min_length=1, max_length=100)
    message: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)


@app.post("/ai/extract-order")
async def extract_order_endpoint(body: ExtractRequest, x_anthropic_api_key: str | None = Header(default=None)):
    """WhatsApp message to draft order. api-node checks auth and saves usage."""
    client = client_for(x_anthropic_api_key, timeout=60.0)
    try:
        result = await extract_order(client, body.model, body.message)
    except ValueError as err:
        if str(err) == "refusal":
            raise HTTPException(422, {"code": "refusal", "message": "The model declined this message. Enter the order by hand."}) from err
        raise HTTPException(422, {"code": "incomplete", "message": "The model did not return a complete draft. Try again or enter the order by hand."}) from err
    except anthropic.NotFoundError as err:
        raise HTTPException(400, {"code": "model", "message": f"The model {body.model} is not available to this key. Pick another on the Settings page."}) from err
    except anthropic.AnthropicError as err:
        raise api_error(err) from err
    # One log line per request with token usage, never the message text.
    log.info(json.dumps({"event": "ai_request", "feature": "extract_order", **result["usage"]}))
    return result


@app.post("/optimize/routes")
def optimize_routes(body: dict):
    """OR-Tools route optimization (Phase 3). Plain def: the solver is CPU
    work, so FastAPI runs it in its thread pool. No API key involved."""
    from optimize import OptimizeRequest, solve

    try:
        req = OptimizeRequest.model_validate(body)
        return solve(req)
    except ValueError as err:
        raise HTTPException(400, {"code": "bad_input", "message": str(err)}) from err


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=256)
    kind: str = Field(pattern="^(query|passage)$")


@app.post("/ai/embed")
def embed_endpoint(body: EmbedRequest):
    """Embeddings for knowledge_chunks (passage) and searches (query).
    A plain def, so FastAPI runs the CPU work in its thread pool."""
    texts = [t[:4000] for t in body.texts]
    return {"model": MODEL_NAME, "dimensions": DIMENSIONS, "vectors": embed(texts, body.kind)}


class ChatRequest(BaseModel):
    model: str = Field(min_length=1, max_length=100)
    messages: list[dict] = Field(min_length=1)
    conversation_id: int
    prompt: str = Field(max_length=4000)
    user_token: str = Field(min_length=10)
    user: dict
    today: str
    ref_offset: int = 0


@app.post("/ai/chat")
async def chat_endpoint(body: ChatRequest, x_anthropic_api_key: str | None = Header(default=None)):
    """One copilot turn as a server-sent event stream. api-node checks auth,
    stores the conversation and keeps the final event to itself."""
    from fastapi.responses import StreamingResponse

    from copilot import run_turn

    client_for(x_anthropic_api_key)  # 400 now if the key is missing
    stream = run_turn(api_key=x_anthropic_api_key, model=body.model, messages=body.messages, user_token=body.user_token,
                      conversation_id=body.conversation_id, prompt=body.prompt, user=body.user, today=body.today,
                      ref_offset=body.ref_offset)
    return StreamingResponse(stream, media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
