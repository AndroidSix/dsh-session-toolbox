/**
 * Package-shape gate: pack the release tarball and prove every entry in the
 * exports map resolves, the versioned host entry exists, and cordis.patch.yml
 * points at it. Run before publishing (npm run check does it cheaply against
 * the working tree; publish.yml runs it against the real tarball).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let dir = null;
try {
	if (process.argv.includes('--tarball')) {
		dir = mkdtempSync(join(tmpdir(), 'sk-pack-'));
		const tgz = execFileSync('npm', ['pack', '--ignore-scripts', '--silent'], { cwd: root, encoding: 'utf8' }).trim().split('\n').at(-1);
		execFileSync('tar', ['-xzf', join(root, tgz), '-C', dir], { stdio: 'pipe' });
		dir = join(dir, 'package');
	} else {
		dir = root;
	}
	const missing = [];
	for (const [specifier, target] of Object.entries(pkg.exports ?? {})) {
		if (!existsSync(join(dir, String(target).replace(/^\.\//, '')))) missing.push(`${specifier} -> ${target}`);
	}
	if (pkg.bin && !existsSync(join(dir, Object.values(pkg.bin)[0].replace(/^\.\//, '')))) missing.push('bin');
	const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8');
	const entry = /name:\s*(\S+)/.exec(patch)?.[1];
	if (entry === undefined || !existsSync(join(dir, entry.replace(/^\.\//, '')))) missing.push(`cordis.patch.yml -> ${entry}`);
	if (!patch.includes(`host-v${pkg.version}.js`)) missing.push('patch id/version drift');
	if (missing.length > 0) {
		console.error(`package shape broken:\n  ${missing.join('\n  ')}`);
		process.exitCode = 1;
	} else {
		console.log(`package shape ok: dsh-session-toolbox@${pkg.version} (${Object.keys(pkg.exports).length} exports, entry ${entry})`);
	}
} finally {
	if (dir !== null && process.argv.includes('--tarball')) rmSync(dirname(dir), { recursive: true, force: true });
}
