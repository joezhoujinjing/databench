"""Unified error envelope.

Every error response — whether it originates from a databench core exception, a
FastAPI request-validation failure, or an explicit ``HTTPException`` raised in a
router — is rendered as a single JSON shape::

    { "error": { "code": <machine_string>, "message": <human>, "detail"?: <any> } }

so the frontend has exactly one error type to model against. The status-code
mapping mirrors how databench surfaces failures:

* :class:`KeyError`                  -> 404 (dataset/version/ref not found)
* :class:`pydantic.ValidationError`  -> 422 (bad params/payload)
* :class:`ValueError`                -> 400 (unparseable input, undetectable kind, ...)
* :class:`TypeError`                 -> 400 (e.g. params passed to a param-less transform)
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException

# HTTP status -> stable machine code for HTTPException / explicit raises.
_STATUS_CODES = {
    400: "bad_request",
    401: "unauthorized",
    403: "forbidden",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    422: "unprocessable_entity",
    429: "too_many_requests",
    500: "internal_error",
}


class ErrorBody(BaseModel):
    code: str = Field(description="stable machine-readable error code")
    message: str = Field(description="human-readable explanation")
    detail: Any | None = Field(default=None, description="optional structured context")


class ErrorResponse(BaseModel):
    error: ErrorBody


def _envelope(status: int, code: str, message: str, detail: Any | None = None) -> JSONResponse:
    body: dict[str, Any] = {"code": code, "message": message}
    if detail is not None:
        body["detail"] = detail
    return JSONResponse(status_code=status, content={"error": body})


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(RequestValidationError)
    async def _on_request_validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        # jsonable_encoder strips non-serialisable bits (e.g. the original
        # exception a model validator embeds in ``ctx``) so the envelope encodes.
        return _envelope(422, "validation_error", "request validation failed", jsonable_encoder(exc.errors()))

    @app.exception_handler(ValidationError)
    async def _on_validation(_: Request, exc: ValidationError) -> JSONResponse:
        return _envelope(422, "validation_error", "payload validation failed", jsonable_encoder(exc.errors()))

    @app.exception_handler(StarletteHTTPException)
    async def _on_http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_CODES.get(exc.status_code, "error")
        return _envelope(exc.status_code, code, str(exc.detail))

    @app.exception_handler(KeyError)
    async def _on_key(_: Request, exc: KeyError) -> JSONResponse:
        message = str(exc.args[0]) if exc.args else str(exc)
        return _envelope(404, "not_found", message)

    @app.exception_handler(ValueError)
    async def _on_value(_: Request, exc: ValueError) -> JSONResponse:
        return _envelope(400, "bad_request", str(exc))

    @app.exception_handler(TypeError)
    async def _on_type(_: Request, exc: TypeError) -> JSONResponse:
        return _envelope(400, "bad_request", str(exc))
