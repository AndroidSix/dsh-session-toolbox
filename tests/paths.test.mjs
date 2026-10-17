import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeSegment, findLogFile, projectKey, projectDir, sessionDir, verifyEncoders, NO_CWD_DIR } from '../src/paths.mjs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('encodeSegment keeps safe units and escapes the rest', () => {
	assert.equal(encodeSegment('session-0120e3ef-282e-4ea4-b07a-3d2f247b7e72'), 'session-0120e3ef-282e-4ea4-b07a-3d2f247b7e72');
	assert.equal(encodeSegment('.'), '~002E');
	assert.equal(encodeSegment('..'), '~002E~002E');
	assert.equal(encodeSegment('a~b'), 'a~007Eb');
	assert.equal(encodeSegment('演示'), '~6F14~793A'); // uppercase hex matches the shipped backend
	assert.throws(() => encodeSegment(''), /empty/);
});

test('projectKey collapses separators and wraps with --…--', () => {
	assert.equal(projectKey('/home/alice/projects/demo'), '--home-alice-projects-demo--');
	assert.equal(projectKey('/Users/dev/Documents/dsh/QA'), '--Users-dev-Documents-dsh-QA--');
	// Windows drive separators take the same treatment as unix ones.
	assert.equal(projectKey('C:\\Users\\dev\\proj'), '--C-Users-dev-proj--');
	// Non-ASCII units escape to code points exactly like the shipped backend.
	assert.equal(projectKey('/home/alice/演示'), `--home-alice-${encodeSegment('演示')}--`);
});

test('projectKey is bounded and root paths survive', () => {
	assert.equal(projectKey('/'), '----'.slice(0, 2) + 'root' + '----'.slice(0, 2));
	assert.ok(projectKey('/' + 'a'.repeat(400)).length <= 2 + 251 + 2);
});

test('projectDir/sessionDir compose the shipped layout', () => {
	const root = '/dsh/sessions';
	assert.equal(projectDir(root, '/home/alice/demo'), join(root, '--home-alice-demo--'));
	assert.equal(projectDir(root, undefined), join(root, NO_CWD_DIR));
	assert.equal(sessionDir(root, '/home/alice/demo', 'session-abc'), join(root, '--home-alice-demo--', 'session-abc'));
});

test('verifyEncoders accepts layouts that reproduce and rejects drift', () => {
	const root = '/root/sessions';
	const good = [{ cwd: '/home/alice/demo', id: 'session-abc', project: projectKey('/home/alice/demo'), dir: encodeSegment('session-abc') }];
	assert.equal(verifyEncoders(good, root), true);
	assert.equal(verifyEncoders([], root), false); // no evidence → not verified
	const drifted = [{ cwd: '/home/alice/demo', id: 'session-abc', project: 'other', dir: encodeSegment('session-abc') }];
	assert.equal(verifyEncoders(drifted, root), false);
});

test('findLogFile prefers compressed highest generation', async t => {
	const dir = await mkdtemp(join(tmpdir(), 'sk-paths-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	assert.equal(await findLogFile(dir), undefined);
	await writeFile(join(dir, 'session.v3.jsonl'), '{}');
	await writeFile(join(dir, 'session.v4.jsonl.zstd'), '{}');
	assert.equal(await findLogFile(dir), 'session.v4.jsonl.zstd');
	await writeFile(join(dir, 'session.jsonl'), '{}');
	assert.equal(await findLogFile(dir), 'session.v4.jsonl.zstd');
});
