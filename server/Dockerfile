# Build from the repository root (web/ sits beside server/):
#   docker build -t classicworld-market-web -f server/Dockerfile .
# Two stages: a Rust builder (service binary + reader WASM), then a
# distroless image with the binary and the web/ tree.

FROM rust:1-bookworm AS builder
WORKDIR /src/server
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version 0.2.129 --locked
# Dependency layer first so code edits do not refetch crates.
COPY server/Cargo.toml server/Cargo.lock ./
COPY server/crates/market-core/Cargo.toml crates/market-core/Cargo.toml
COPY server/crates/market-reader-wasm/Cargo.toml crates/market-reader-wasm/Cargo.toml
COPY server/crates/market-web/Cargo.toml crates/market-web/Cargo.toml
RUN mkdir -p crates/market-core/src crates/market-reader-wasm/src crates/market-web/src \
 && echo 'pub fn _dep_cache() {}' > crates/market-core/src/lib.rs \
 && echo '' > crates/market-reader-wasm/src/lib.rs \
 && echo 'fn main() {}' > crates/market-web/src/main.rs \
 && echo '' > crates/market-web/src/lib.rs \
 && cargo build --release --locked -p market-web --bin market-web \
 && cargo build --release --locked --target wasm32-unknown-unknown -p market-reader-wasm \
 && rm -rf crates/*/src
COPY server/crates crates
COPY server/migrations migrations
COPY server/static static
COPY server/tools/build_reader_wasm.sh tools/build_reader_wasm.sh
COPY web /src/web
# Touch sources so cargo rebuilds them over the cached stubs.
RUN find crates -name '*.rs' -exec touch {} + \
 && cargo build --release --locked -p market-web --bin market-web \
 && sh tools/build_reader_wasm.sh

FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /src/server/target/release/market-web /market-web
COPY --from=builder /src/web /web
ENV BIND=0.0.0.0:8080 WEB_DIR=/web
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/market-web"]
