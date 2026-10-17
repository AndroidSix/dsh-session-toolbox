import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { readHeader, rewriteHeaderFrame, scanFrames } from '../src/session-log.mjs';
import { encodeSegment, projectKey } from '../src/paths.mjs';

/**
 * Opt-in validation against genuine installed-DSH artifacts (read-only; set
 * `DSH_SESSION_KIT_LIVE=1`). Every stored session log must walk with the
 * official-equivalent scanner, survive a header rewrite, and re-walk. The
 * rewrite target is a throwaway temp path — real stores are never written.
 * Nothing leaves the machine; nothing is logged beyond counts and paths.
 */
const enabled = process.env.DSH_SESSION_KIT_LIVE === '1';
const realRoot = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions');
let artifacts = [];
if (enabled) try {
	for (const project of await readdir(realRoot, { withFileTypes: true })) {
		if (!project.isDirectory() || project.name.startsWith('.')) continue;
		for (const entry of await readdir(join(realRoot, project.name), { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = join(realRoot, project.name, entry.name);
			const files = await readdir(dir);
			const log = files.find(name => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(name));
			if (log !== undefined) artifacts.push({ file: join(dir, log), project: project.name, segment: entry.name });
		}
	}
} catch { /* unreadable install */ }

const line = buf => zstdDecompressSync(buf).toString('utf8');

test(`real session logs (${artifacts.length} found): walk + rewrite + re-walk`, async t => {
	if (!enabled) return t.skip('set DSH_SESSION_KIT_LIVE=1 to validate against the local install');
	assert.ok(artifacts.length > 0, 'DSH_SESSION_KIT_LIVE=1 but no session logs found under the sessions root');
	for (const artifact of artifacts) {
		const bytes = await readFile(artifact.file);
		const { header, frames } = readHeader(bytes);
		assert.equal(header.type, 'session', `${artifact.file}: header parses`);
		if (header.cwd !== undefined) assert.equal(artifact.project, projectKey(header.cwd), `${artifact.file}: projectKey(cwd) matches placement`);
		assert.equal(artifact.segment, encodeSegment(header.id), `${artifact.file}: encodeSegment(id) matches placement`);
		const out = rewriteHeaderFrame(bytes, '/rewrite/probe-target');
		const after = scanFrames(out);
		assert.equal(after.length, frames.length, `${artifact.file}: frame count preserved`);
		for (let i = 1; i < frames.length; i++) {
			assert.equal(line(out.subarray(after[i].start, after[i].end)), line(bytes.subarray(frames[i].start, frames[i].end)),
				`${artifact.file}: frame ${i} payload identical after rewrite`);
		}
		assert.equal(readHeader(out).header.cwd, '/rewrite/probe-target');
	}
});

test('a rewritten copy reloads byte-stably from disk', async t => {
	if (!enabled) return t.skip('set DSH_SESSION_KIT_LIVE=1 to validate against the local install');
	const artifact = artifacts.find(row => row.segment.includes('0120e3ef')) ?? artifacts[0];
	if (artifact === undefined) return t.skip('no artifacts to rewrite');
	const base = await mkdtemp(join(tmpdir(), 'sk-live-'));
	t.after(() => rm(base, { recursive: true, force: true }));
	const target = join(base, 'session.v4.jsonl.zstd');
	await copyFile(artifact.file, target);
	const rewritten = rewriteHeaderFrame(await readFile(target), base);
	await writeFile(target, rewritten);
	const again = await readFile(target);
	assert.deepEqual(again, rewritten, 'disk round-trip byte-stable');
	assert.equal(readHeader(again).header.cwd, base);
	assert.ok((await stat(target)).size > 0);
});
