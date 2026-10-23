#!/bin/sh
# Builds the screen reader for the browser into web/collect/pkg/.
# Needs: rustup target add wasm32-unknown-unknown
#        cargo install wasm-bindgen-cli --version 0.2.129 --locked
set -eu
cd "$(dirname "$0")/.."
want=0.2.129
have=$(wasm-bindgen --version | awk '{print $2}')
if [ "$have" != "$want" ]; then
  echo "wasm-bindgen $want needed (found $have): cargo install wasm-bindgen-cli --version $want --locked" >&2
  exit 1
fi
cargo build --release --locked --target wasm32-unknown-unknown -p market-reader-wasm
wasm-bindgen --target web --no-typescript --out-dir ../web/collect/pkg \
  target/wasm32-unknown-unknown/release/market_reader_wasm.wasm
ls -l ../web/collect/pkg
