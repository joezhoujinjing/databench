FROM ghcr.io/astral-sh/uv:0.11.1 AS uv

FROM python:3.11.15-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_NO_DEV=1

WORKDIR /app
COPY --from=uv /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN uv sync --frozen --no-dev

USER 65532:65532
EXPOSE 50051
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=12 \
  CMD ["/app/.venv/bin/databench-worker-healthcheck"]
ENTRYPOINT ["/app/.venv/bin/databench-worker"]
CMD ["--listen", "0.0.0.0:50051"]
