# syntax=docker/dockerfile:1

FROM node:20-bookworm AS build
WORKDIR /app

# OS deps: whisper.cpp build + ffmpeg for resampling
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git ca-certificates curl ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# Build whisper.cpp
# NOTE: whisper.cpp CLI flags are not fully stable across commits. Prefer pinning WHISPER_CPP_REF.
ARG WHISPER_CPP_REF=master
RUN git clone https://github.com/ggerganov/whisper.cpp.git /tmp/whisper.cpp \
  && cd /tmp/whisper.cpp \
  && git checkout ${WHISPER_CPP_REF} \
  && cmake -S . -B build -DWHISPER_BUILD_TESTS=OFF \
  && cmake --build build -j \
  && mkdir -p /opt/whispercpp/lib \
  && (cp build/bin/whisper-cli /opt/whispercpp/whisper-cli || true) \
  && (cp build/bin/main /opt/whispercpp/main || true) \
  && (find /tmp/whisper.cpp -type f -name 'libwhisper.so*' -exec cp -v {} /opt/whispercpp/lib/ \; || true) \
  && (find /tmp/whisper.cpp -type f -name 'libggml*.so*' -exec cp -v {} /opt/whispercpp/lib/ \; || true) \
  && (cd /opt/whispercpp/lib \
        && (ls -la || true) \
        && (ln -sf libwhisper.so.* libwhisper.so.1 || true) \
        && (ln -sf libggml.so.* libggml.so.0 || true) \
        && (ln -sf libggml-base.so.* libggml-base.so.0 || true) \
        && (ln -sf libggml-cpu.so.* libggml-cpu.so.0 || true) \
        && (ln -sf libggml-metal.so.* libggml-metal.so.0 || true) \
        && (ln -sf libggml-blas.so.* libggml-blas.so.0 || true) \
        && (ln -sf libggml-cuda.so.* libggml-cuda.so.0 || true) \
        && (ln -sf libggml-vulkan.so.* libggml-vulkan.so.0 || true))

# Install piper binary (release build)
# Note: this fetches a pinned release asset. If it breaks, use your own piper build and set PIPER_BIN.
ARG PIPER_VERSION=1.2.0
RUN mkdir -p /opt/piper \
  && curl -fL -o /tmp/piper.tar.gz https://github.com/rhasspy/piper/releases/download/v${PIPER_VERSION}/piper_amd64.tar.gz \
  && tar -xzf /tmp/piper.tar.gz -C /opt/piper --strip-components=1 \
  && rm -f /tmp/piper.tar.gz

# Node deps
COPY services/ragnar-backend-v2/package.json services/ragnar-backend-v2/package-lock.json* ./services/ragnar-backend-v2/
WORKDIR /app/services/ragnar-backend-v2
RUN npm ci

COPY services/ragnar-backend-v2 ./
RUN npm run build

FROM node:20-bookworm AS runtime
WORKDIR /app/services/ragnar-backend-v2

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/whispercpp /opt/whispercpp
COPY --from=build /opt/piper /opt/piper
COPY --from=build /app/services/ragnar-backend-v2/dist ./dist
COPY --from=build /app/services/ragnar-backend-v2/node_modules ./node_modules
COPY --from=build /app/services/ragnar-backend-v2/package.json ./package.json
# Needed for downloading models onto the Render persistent disk at runtime
COPY --from=build /app/services/ragnar-backend-v2/scripts ./scripts

# Render injects PORT; we should not override it here.
ENV WHISPER_CPP_BIN=/opt/whispercpp/whisper-cli \
    LD_LIBRARY_PATH=/opt/whispercpp/lib \
    PIPER_BIN=/opt/piper/piper \
    FFMPEG_BIN=ffmpeg

# On first boot, download models onto the persistent disk (if mounted at /var/data).
CMD ["bash", "-lc", "node scripts/fetch-models.mjs && node dist/server.js"]
