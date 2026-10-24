"use strict";

function getServerNodeArgs(serverBin, serverArgs, arch = process.arch) {
  if (arch === "riscv64") {
    return ["--no-wasm-lazy-compilation", serverBin, ...serverArgs];
  }

  return [serverBin, ...serverArgs];
}

module.exports = { getServerNodeArgs };
