# Multi-stage build for the Kesami core backend. The builder compiles the Rust
# binary with the prebuilt ONNX Runtime binaries fastembed downloads at build
# time; the runtime image carries only the binary and its TLS roots.
FROM rust:1.98-trixie AS builder

WORKDIR /build

# Layer-cache dependencies: the manifests change far less often than the source.
# --locked fails loudly if Cargo.lock drifts from Cargo.toml.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release --locked && rm -rf src

COPY src ./src
COPY migrations ./migrations
RUN touch src/main.rs && cargo build --release --locked

FROM debian:trixie-slim AS runtime

# HTTPS provider clients (Sarvam, Gemini) validate certificates through the
# system trust store at runtime; setpriv drops from root to the unprivileged
# user after the entrypoint fixes the volume ownership.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --create-home --shell /usr/sbin/nologin kesami

COPY --from=builder /build/target/release/kesami-core-backend /usr/local/bin/kesami-core-backend
COPY entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 0755 /usr/local/bin/entrypoint

# Meeting library, settings, credentials, and the chat embedding model all live
# under KESAMI_DATA_DIR, which fly mounts as a persistent volume.
ENV KESAMI_DATA_DIR=/data \
    CORE_BACKEND_HOST=0.0.0.0 \
    CORE_BACKEND_PORT=48900
VOLUME /data
EXPOSE 48900

WORKDIR /data

# Fly probes /health per fly.toml; no Docker HEALTHCHECK needed. The container
# starts as root only to fix /data ownership, then the entrypoint drops to
# `kesami` for the server process.
ENTRYPOINT ["/usr/local/bin/entrypoint"]
