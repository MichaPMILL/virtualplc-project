#!/bin/sh
# Builds the simulated CPU (WebAssembly) used by the Studio: sdk/wasm/vplc-sim.wasm
# Needs clang >= 15 with the wasm32 target, wasi-libc and the wasm32 compiler-rt builtins
# (Debian / Ubuntu: apt install clang lld wasi-libc libclang-rt-18-dev-wasm32).
set -e
cd "$(dirname "$0")"
OUT=../../sdk/wasm/vplc-sim.wasm
SYSROOT=${WASI_SYSROOT:-/usr}
mkdir -p "$(dirname "$OUT")"
clang++ --target=wasm32-wasi --sysroot="$SYSROOT" -isystem "$SYSROOT/include/wasm32-wasi" -L"$SYSROOT/lib/wasm32-wasi" \
  -O2 -std=c++17 -fno-exceptions -fno-rtti -nostdlib++ -DVPLC_WASM=1 \
  -mexec-model=reactor -Wl,--no-entry -Wl,--export-dynamic -Wl,--strip-all -Wl,-z,stack-size=262144 \
  -Wall -Wextra \
  vplc_wasm.cpp ../core/cpu.cpp ../core/vm.cpp ../core/program.cpp ../core/protocol.cpp ../core/crc32.cpp \
  -o "$OUT"
echo "built $OUT ($(wc -c < "$OUT") bytes)"
