/**
 * Global test setup file for Vitest
 *
 * Loads Rust WASM module from openfront-core and patches JS functions
 * to use Rust implementations when available.
 */

import path from "path";
import { beforeAll } from "vitest";

// Type for the Rust WASM module
type RustCore = typeof import("../../../openfront-core/pkg/openfront_core");

// Global state for Rust WASM
declare global {
  var __RUST_WASM_AVAILABLE__: boolean;
  var __RUST_CORE__: RustCore | null;
}

globalThis.__RUST_WASM_AVAILABLE__ = false;
globalThis.__RUST_CORE__ = null;

/**
 * Load the Rust WASM module from openfront-core
 */
function loadRustCore(): RustCore {
  // Resolve relative to project root (cwd), not __dirname
  const wasmPath = path.resolve(
    process.cwd(),
    "../openfront-core/pkg/openfront_core.js",
  );
  // Use require for Node.js compatibility
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(wasmPath);
}

/**
 * Mapping of JS functions to Rust replacements.
 * Add entries here as Rust implementations become ready.
 */

type AnyFn = (...args: any[]) => any;

const RUST_REPLACEMENTS: Record<
  string,
  {
    target: () => any;
    method: string;
    rustFn: (rustCore: RustCore, original: AnyFn) => AnyFn;
  }
> = {
  // Example: when Rust tick is ready, uncomment:
  // "GameImpl.executeNextTick": {
  //   target: () => require("../src/core/game/GameImpl").GameImpl.prototype,
  //   method: "executeNextTick",
  //   rustFn: (rustCore, original) => function(this: any) {
  //     // Call Rust instead
  //     return original.call(this);
  //   }
  // },
};

beforeAll(async () => {
  if (process.env.USE_RUST_CORE === "0") {
    console.log("[TestSetup] Rust WASM disabled via USE_RUST_CORE=0");
    return;
  }

  try {
    const core = loadRustCore();
    globalThis.__RUST_WASM_AVAILABLE__ = true;
    globalThis.__RUST_CORE__ = core;

    // Apply Rust replacements
    let patchCount = 0;
    for (const [name, config] of Object.entries(RUST_REPLACEMENTS)) {
      try {
        const target = config.target();
        const original = target[config.method];
        if (typeof original === "function") {
          target[config.method] = config.rustFn(core, original);
          patchCount++;
          console.log(`[TestSetup] Patched ${name} -> Rust`);
        }
      } catch (e) {
        console.warn(`[TestSetup] Failed to patch ${name}:`, e);
      }
    }

    console.log(
      `[TestSetup] Rust WASM loaded, ${patchCount} functions patched`,
    );
  } catch {
    console.log("[TestSetup] Rust WASM not available, using pure JS");
  }
});

export function isRustAvailable(): boolean {
  return globalThis.__RUST_WASM_AVAILABLE__;
}

export function getRustCore(): RustCore | null {
  return globalThis.__RUST_CORE__;
}
