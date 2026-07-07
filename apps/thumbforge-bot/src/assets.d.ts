// Ambient declarations for wrangler/esbuild binary imports (Worker bundle only).
// `.ttf` files are bundled as raw bytes via a `Data` module rule (wrangler.jsonc)
// and `.wasm` files compile to a `WebAssembly.Module` via the built-in
// `CompiledWasm` rule. tsc uses these wildcard modules so `renderAssets.ts`
// type-checks; the Node test/render paths never import them (they read bytes
// off disk via fonts/node.ts + render/wasm.node.ts).

declare module '*.ttf' {
  const data: ArrayBuffer;
  export default data;
}

declare module '*.wasm' {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
