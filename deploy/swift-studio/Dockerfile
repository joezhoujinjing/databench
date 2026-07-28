ARG SWIFT_BASE_IMAGE=pytorch/pytorch:2.8.0-cuda12.8-cudnn9-runtime@sha256:417bd75df6365104c283ea4c1651fb3530d9eb5a4c2fafa51943cff2a94e6385
FROM ${SWIFT_BASE_IMAGE}

ARG MS_SWIFT_SOURCE_SHA256=60eeb1a53a089306166899951950e195144dc025002ffeffa700067be2787d48
ARG MS_SWIFT_PATCH_SHA256=0340badc58b1ca57b40cac2d21e24c59c80eb3f8ab293887304c41832cab076f
ARG MS_SWIFT_PYTHON311_PATCH_SHA256=a2788b119b942e2485dbd9686fe236f718701843f17ed5dcbc12ed38c9af9bce
ARG SWIFT_RUNTIME_LOCK_SHA256=4ed9ea77fc7228a758a2cd077b65e3ea0b5a6dfe7bb0cedb2ef78b85618655ba
ARG SWIFT_RUNTIME_INPUT_SHA256=22af95e22c763ae3469129bb6945c2037af9a3780834d27fc81e241f62a9de00
ARG SWIFT_RUNTIME_PROVIDED_SHA256=8b3e8f74d618235841e803f9ff21dff3fd4033d3d399662377ee6b2ff27087d8

LABEL org.opencontainers.image.title="Databench Swift Studio" \
      org.opencontainers.image.description="Pinned native ms-swift Gradio Studio runtime" \
      org.opencontainers.image.licenses="Apache-2.0" \
      io.databench.ms-swift.commit="f48847d23dbcd72ceb15fdbc5a1482cc7eb0359d"

ENV DATABENCH_SWIFT_PROVIDER_HOST=0.0.0.0 \
    DATABENCH_SWIFT_PROVIDER_PORT=7861 \
    DATABENCH_SWIFT_ROOT_PATH=/swift-studio \
    DATABENCH_SWIFT_SESSION_LABEL="Databench Swift Studio" \
    DATABENCH_SWIFT_WORKSPACE_ROOT=/var/lib/databench-swift-studio \
    GRADIO_ANALYTICS_ENABLED=False \
    HF_HUB_DISABLE_TELEMETRY=1 \
    HF_HOME=/var/lib/databench-swift-studio/cache/huggingface \
    MODELSCOPE_CACHE=/var/lib/databench-swift-studio/cache/modelscope \
    PYTHONPATH=/opt/databench-swift-studio \
    PYTHONUNBUFFERED=1 \
    SWIFT_UI_LANG=zh \
    WEBUI_PORT=7860 \
    WEBUI_SERVER=0.0.0.0 \
    WEBUI_SHARE=false

WORKDIR /opt/build

COPY third_party/ms-swift/vendor/ms-swift-upstream.tar.gz /opt/build/ms-swift-upstream.tar.gz
COPY third_party/ms-swift/patches/0001-databench-session-prefill.patch /opt/build/databench-session-prefill.patch
COPY third_party/ms-swift/patches/0002-python311-attrdict3-metadata.patch /opt/build/python311-attrdict3-metadata.patch
COPY third_party/ms-swift/runtime-requirements.in /opt/build/runtime-requirements.in
COPY third_party/ms-swift/runtime-provided.txt /opt/build/runtime-provided.txt
COPY third_party/ms-swift/runtime-requirements.lock /opt/build/runtime-requirements.lock
COPY scripts/apply-swift-patch.py /opt/build/apply-swift-patch.py

RUN printf '%s  %s\n' "${MS_SWIFT_SOURCE_SHA256}" /opt/build/ms-swift-upstream.tar.gz | sha256sum -c - \
    && printf '%s  %s\n' "${MS_SWIFT_PATCH_SHA256}" /opt/build/databench-session-prefill.patch | sha256sum -c - \
    && printf '%s  %s\n' "${MS_SWIFT_PYTHON311_PATCH_SHA256}" /opt/build/python311-attrdict3-metadata.patch | sha256sum -c - \
    && printf '%s  %s\n' "${SWIFT_RUNTIME_INPUT_SHA256}" /opt/build/runtime-requirements.in | sha256sum -c - \
    && printf '%s  %s\n' "${SWIFT_RUNTIME_PROVIDED_SHA256}" /opt/build/runtime-provided.txt | sha256sum -c - \
    && printf '%s  %s\n' "${SWIFT_RUNTIME_LOCK_SHA256}" /opt/build/runtime-requirements.lock | sha256sum -c - \
    && python -c "import sys, torch; assert sys.version_info[:2] == (3, 11); assert torch.__version__.split('+', 1)[0] == '2.8.0'" \
    && mkdir -p /opt/ms-swift \
    && tar -xzf /opt/build/ms-swift-upstream.tar.gz --strip-components=1 -C /opt/ms-swift \
    && python /opt/build/apply-swift-patch.py /opt/ms-swift /opt/build/databench-session-prefill.patch \
    && python /opt/build/apply-swift-patch.py /opt/ms-swift /opt/build/python311-attrdict3-metadata.patch

RUN python -m pip install --no-cache-dir --no-deps --require-hashes -r /opt/build/runtime-requirements.lock

RUN python -m pip install --no-cache-dir --no-deps /opt/ms-swift \
    && python -m pip check \
    && python -c "import attrdict, cpm_kernels, evalscope, gradio, peft, swift, transformers; assert gradio.__version__ == '5.50.0'; assert swift.__version__ == '4.4.2'; assert transformers.__version__ == '4.57.6'"

ARG SWIFT_PROVIDER_RUNTIME_INPUT_SHA256=92dab8d12d555dd7437962675a65185cae134632cc1a19a5519fb53c5fa447b9
ARG SWIFT_PROVIDER_RUNTIME_LOCK_SHA256=28dfff03d39b58d94b0969b83eee89c9229d1519c84c8f2ea83c05d6a304d748
ARG SWIFT_CAPABILITY_MANIFEST_SHA256=01d259849837484b8ed00c013ed53d45548a525384317b856edebee02d5956b4

COPY workers/swift-studio/runtime-requirements.in /opt/build/provider-runtime-requirements.in
COPY workers/swift-studio/runtime-requirements.lock /opt/build/provider-runtime-requirements.lock
COPY third_party/ms-swift/runtime-capabilities.json /opt/databench-swift-studio/runtime-capabilities.json

RUN printf '%s  %s\n' "${SWIFT_PROVIDER_RUNTIME_INPUT_SHA256}" /opt/build/provider-runtime-requirements.in | sha256sum -c - \
    && printf '%s  %s\n' "${SWIFT_PROVIDER_RUNTIME_LOCK_SHA256}" /opt/build/provider-runtime-requirements.lock | sha256sum -c - \
    && printf '%s  %s\n' "${SWIFT_CAPABILITY_MANIFEST_SHA256}" /opt/databench-swift-studio/runtime-capabilities.json | sha256sum -c - \
    && python -m pip install --no-cache-dir --no-deps --require-hashes -r /opt/build/provider-runtime-requirements.lock \
    && python -c "import blake3; assert blake3.__version__ == '1.0.8'"

COPY workers/swift-studio/src /opt/databench-swift-studio

RUN groupadd --gid 10002 swiftstudio \
    && useradd --uid 10002 --gid 10002 --home-dir /var/lib/databench-swift-studio/home --no-create-home --shell /usr/sbin/nologin swiftstudio \
    && mkdir -p \
      /var/lib/databench-swift-studio/cache \
      /var/lib/databench-swift-studio/home \
      /var/lib/databench-swift-studio/inputs \
      /var/lib/databench-swift-studio/logs \
      /var/lib/databench-swift-studio/outputs \
    && chown -R 10002:10002 /var/lib/databench-swift-studio \
    && chmod 0750 \
      /var/lib/databench-swift-studio \
      /var/lib/databench-swift-studio/cache \
      /var/lib/databench-swift-studio/home \
      /var/lib/databench-swift-studio/inputs \
      /var/lib/databench-swift-studio/logs \
      /var/lib/databench-swift-studio/outputs

WORKDIR /var/lib/databench-swift-studio
USER 10002:10002
EXPOSE 7860 7861

HEALTHCHECK --interval=20s --timeout=5s --retries=12 --start-period=90s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7861/health', timeout=3).read()"

CMD ["python", "-m", "databench_swift_studio.launcher"]
