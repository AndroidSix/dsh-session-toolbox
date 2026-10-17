import { build } from 'esbuild';
import { chmod, copyFile, readFile, rm, writeFile } from 'node:fs/promises';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await rm('lib', { recursive: true, force: true });
// Host bundle: node ESM, official DSH packages stay external (provided by the running host).
await build({ entryPoints: { index: 'src/index.mjs', cli: 'src/cli.mjs' },
  outdir: 'lib', bundle: true, splitting: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
  sourcemap: true, legalComments: 'eof' });
await chmod('lib/cli.js', 0o755);
await copyFile('lib/index.js', 'lib/host.js');
await copyFile('lib/index.js', `lib/host-v${version}.js`);
// Versioned entry + versioned component id: every release replaces the server and browser module
// generations together so a hot reload can never keep executing the previous build.
await writeFile('cordis.patch.yml', `- insert:\n    - id: session-kit-v1-${version}\n      name: ./lib/host-v${version}.js\n`);
// Client bundle: browser CJS wrapped for __ModuleLoader__, React/slots resolved by the host loader.
// The draft vault is imported directly by the client (one browser bundle, no loader/CSP surface).
await build({ entryPoints: { client: 'src/client.jsx' }, outdir: 'lib', bundle: true, platform: 'browser', format: 'cjs',
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-session-kit", factory: (require) => { var module = { exports: {} };' },
  footer: { js: 'return module.exports; } });' },
  target: 'es2022', packages: 'external', jsx: 'automatic', sourcemap: true, legalComments: 'eof' });
