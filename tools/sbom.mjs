#!/usr/bin/env node
// Software bill of materials (CycloneDX 1.5 JSON) of VirtualPLC: npm packages of the SDK and
// the Studio (from the lockfiles, with licenses and integrity hashes) and the native
// libraries of the CPU runtime. Usage: node tools/sbom.mjs [--dev] [out.json]
// (NIS2 art. 21 supply chain, IEC 62443-4-1 SM-9, PCI DSS 6.3.2: inventory of components)
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

const root = new URL('../', import.meta.url);
const args = process.argv.slice(2);
const dev = args.includes('--dev');
const out = args.find((a) => !a.startsWith('--'));
const read = (p) => readFileSync(new URL(p, root), 'utf8');

const components = new Map();
const add = (c) => components.set(c['bom-ref'], { ...components.get(c['bom-ref']), ...c });

for (const project of ['sdk', 'studio']) {
  const lock = JSON.parse(read(`${project}/package-lock.json`));
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (!path || (p.dev && !dev) || !p.version) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const purl = `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${p.version}`;
    const hashes = [];
    const m = /^sha512-(.+)$/.exec(p.integrity ?? '');
    if (m) hashes.push({ alg: 'SHA-512', content: Buffer.from(m[1], 'base64').toString('hex') });
    add({
      type: 'library', 'bom-ref': purl, name, version: p.version, purl,
      ...(p.license ? { licenses: [{ expression: p.license }] } : {}),
      ...(hashes.length ? { hashes } : {}),
      ...(p.resolved ? { externalReferences: [{ type: 'distribution', url: p.resolved }] } : {}),
      scope: p.dev ? 'optional' : 'required',
      properties: [{ name: 'virtualplc:used-by', value: project }],
    });
  }
}

// Native libraries of vplc-cpu (versions of the build machine for the system libraries)
const cmake = read('runtime/CMakeLists.txt');
const o62 = /set\(VPLC_OPEN62541_VERSION ([\d.]+)\)/.exec(cmake)?.[1] ?? 'unknown';
add({ type: 'library', 'bom-ref': `pkg:github/open62541/open62541@v${o62}`, name: 'open62541', version: o62, purl: `pkg:github/open62541/open62541@v${o62}`,
  licenses: [{ license: { id: 'MPL-2.0' } }], description: 'OPC UA server of vplc-cpu (downloaded with a pinned SHA-256)' });
add({ type: 'library', 'bom-ref': 'pkg:generic/openssl', name: 'OpenSSL', version: 'system (>= 3.0)', purl: 'pkg:generic/openssl',
  licenses: [{ license: { id: 'Apache-2.0' } }], description: 'TLS, SHA-256, Ed25519, PBKDF2 (system library)' });
add({ type: 'library', 'bom-ref': 'pkg:generic/sqlite', name: 'SQLite', version: 'system (>= 3.35)', purl: 'pkg:generic/sqlite',
  licenses: [{ expression: 'blessing' }], description: 'Local database of the data logs (public domain)' });

const version = JSON.parse(read('sdk/package.json')).version ?? '0.0.0';
const bom = {
  bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: `urn:uuid:${randomUUID()}`, version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: { components: [{ type: 'application', name: 'virtualplc-sbom', version }] },
    component: { type: 'application', 'bom-ref': 'virtualplc', name: 'VirtualPLC', version, licenses: [{ license: { id: 'BSD-3-Clause' } }] },
  },
  components: [...components.values()].sort((a, b) => a.name.localeCompare(b.name)),
};
const text = `${JSON.stringify(bom, null, 2)}\n`;
if (out) {
  writeFileSync(out, text);
  console.error(`${bom.components.length} components, sha256 ${createHash('sha256').update(text).digest('hex')} -> ${out}`);
} else {
  process.stdout.write(text);
}
