// Bundles the Electron main process, the preload script and the renderer.
import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist/renderer', { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'warning', legalComments: 'none' };
await Promise.all([
  // import.meta is only used when __dirname is not defined (ESM bundle)
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs', platform: 'node', format: 'cjs', external: ['electron'], target: 'node20', logOverride: { 'empty-import-meta': 'silent' } }),
  build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.cjs', platform: 'node', format: 'cjs', external: ['electron'], target: 'node20' }),
  build({ ...common, entryPoints: ['src/backend/api.ts'], outfile: 'dist/backend.mjs', platform: 'node', format: 'esm', target: 'node20', external: ['serialport'] }),
  build({ ...common, entryPoints: ['src/renderer/main.ts'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife', target: 'chrome120', minify: !watch }),
]);
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
// Simulated CPU (WebAssembly build of the CPU core, see runtime/wasm)
cpSync('../sdk/wasm/vplc-sim.wasm', 'dist/vplc-sim.wasm');
console.log('Studio built into dist/');
