ARG PYTHON_IMAGE=python:3.12.11-slim-bookworm@sha256:519591d6871b7bc437060736b9f7456b8731f1499a57e22e6c285135ae657bf7
FROM ${PYTHON_IMAGE}

ARG UV_VERSION=0.11.1
ARG EVALSCOPE_SOURCE_SHA256=39073ef3b55906cef8fc072a4851ee27e3efa064fd9289f84837a67730ed1579
ARG PLOTLY_SHA256=6d21266ce1bd7d9e5ab4e115989c70c20de0382fd973a8f26ab58619eba4d603
ARG PLOTLY_LICENSE_SHA256=67a26cf80f03ff388f26945dfc1f6caed1a0746ff43871190339b3aee49b94bb
ARG NLTK_PUNKT_TAB_SHA256=e57f64187974277726a3417ca6f181ec5403676c717672eef6a748a7b20e0106

ENV DEBIAN_FRONTEND=noninteractive \
    EVALSCOPE_SERVE_WEB=false \
    NLTK_DATA=/opt/nltk_data \
    PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates patch \
    && python -m pip install --no-cache-dir "uv==${UV_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/workers/evalscope
COPY workers/evalscope/pyproject.toml workers/evalscope/uv.lock ./
COPY deploy/evalscope/vendor/evalscope-upstream.tar.gz /workspace/deploy/evalscope/vendor/evalscope-upstream.tar.gz

RUN printf '%s  %s\n' "${EVALSCOPE_SOURCE_SHA256}" /workspace/deploy/evalscope/vendor/evalscope-upstream.tar.gz | sha256sum -c - \
    && uv sync --frozen --no-dev --no-install-package evalscope

ARG EVALSCOPE_PATCH_SHA256=df739d26eea044748819b2a1381969d9f89ce8c11682e5ac54b2cf52dc53113a
COPY deploy/evalscope/vendor/plotly-2.35.2.min.js /opt/vendor/plotly-2.35.2.min.js
COPY deploy/evalscope/vendor/plotly-LICENSE.txt /opt/vendor/plotly-LICENSE.txt
COPY deploy/evalscope/vendor/punkt_tab.zip /opt/vendor/punkt_tab.zip
COPY deploy/evalscope/patches/0001-databench-runtime-boundary.patch /opt/patches/0001-databench-runtime-boundary.patch

RUN printf '%s  %s\n' "${EVALSCOPE_PATCH_SHA256}" /opt/patches/0001-databench-runtime-boundary.patch | sha256sum -c - \
    && printf '%s  %s\n' "${PLOTLY_SHA256}" /opt/vendor/plotly-2.35.2.min.js | sha256sum -c - \
    && printf '%s  %s\n' "${PLOTLY_LICENSE_SHA256}" /opt/vendor/plotly-LICENSE.txt | sha256sum -c - \
    && printf '%s  %s\n' "${NLTK_PUNKT_TAB_SHA256}" /opt/vendor/punkt_tab.zip | sha256sum -c - \
    && python -m zipfile -e /opt/vendor/punkt_tab.zip /opt/nltk_data/tokenizers \
    && mkdir -p /opt/src \
    && tar -xzf /workspace/deploy/evalscope/vendor/evalscope-upstream.tar.gz -C /opt/src \
    && cd /opt/src/evalscope-upstream \
    && patch --batch --forward -p1 < /opt/patches/0001-databench-runtime-boundary.patch \
    && uv pip install --python /app/.venv/bin/python --no-deps /opt/src/evalscope-upstream \
    && cp -a /opt/src/evalscope-upstream/evalscope/. /app/.venv/lib/python3.12/site-packages/evalscope/ \
    && rm -rf /app/.venv/lib/python3.12/site-packages/evalscope/web \
    && test -f /app/.venv/lib/python3.12/site-packages/evalscope/report/template/report.html.j2 \
    && test -f /app/.venv/lib/python3.12/site-packages/evalscope/benchmarks/_meta/general_qa.json \
    && test ! -e /app/.venv/lib/python3.12/site-packages/evalscope/web

COPY workers/evalscope/src /app/src

RUN groupadd --gid 10001 evalscope \
    && useradd --uid 10001 --gid 10001 --home-dir /var/lib/evalscope/home --no-create-home --shell /usr/sbin/nologin evalscope \
    && mkdir -p /var/lib/evalscope/outputs /var/lib/evalscope/inputs /var/lib/evalscope/home \
    && chown -R 10001:10001 /var/lib/evalscope \
    && chmod 0750 /var/lib/evalscope/outputs /var/lib/evalscope/inputs /var/lib/evalscope/home \
    && chmod 0444 /opt/vendor/plotly-2.35.2.min.js /opt/vendor/plotly-LICENSE.txt /opt/vendor/punkt_tab.zip \
    && test -f /opt/vendor/plotly-LICENSE.txt \
    && test -f /opt/nltk_data/tokenizers/punkt_tab/english/ortho_context.tab

WORKDIR /app
USER 10001:10001
EXPOSE 9000

HEALTHCHECK --interval=20s --timeout=5s --retries=6 --start-period=20s \
  CMD /app/.venv/bin/python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:9000/health', timeout=3).read()"

CMD ["/app/.venv/bin/gunicorn", "--bind=0.0.0.0:9000", "--workers=1", "--threads=8", "--timeout=86400", "--graceful-timeout=30", "--access-logfile=/dev/null", "--error-logfile=-", "databench_evalscope.wsgi:application"]
