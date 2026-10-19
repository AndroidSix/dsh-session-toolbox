import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('a failed npm pack cleans only the directory owned by the package check', async t => {
	const root = await mkdtemp(join(tmpdir(), 'sk-pack-failure-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const shared = join(root, 'shared-temp');
	const bin = join(root, 'bin');
	await mkdir(shared); await mkdir(bin);
	await writeFile(join(shared, 'unrelated'), 'keep');
	await writeFile(join(bin, 'npm'), '#!/bin/sh\nexit 1\n');
	await chmod(join(bin, 'npm'), 0o755);
	const result = spawnSync(process.execPath, ['scripts/check-package.mjs', '--tarball'], {
		cwd: new URL('..', import.meta.url), env: { ...process.env, TMPDIR: shared, PATH: bin }, encoding: 'utf8',
	});
	assert.equal(result.status, 1);
	assert.equal(await readFile(join(shared, 'unrelated'), 'utf8'), 'keep');
	assert.deepEqual(await readdir(shared), ['unrelated']);
});
