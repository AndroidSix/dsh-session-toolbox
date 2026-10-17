import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { readHeader, rewriteHeaderFrame, scanFrames } from '../src/session-log.mjs';
import { sessionArtifact } from './helpers/zstd-frames.mjs';

const framesText = buffer => scanFrames(buffer).map(frame => zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'));

/** Build a multi-frame artifact like the shipped writer: header frame + one frame per event. */
function fixture(header = {}) {
	return sessionArtifact({ type: 'session', version: 4, id: 'session-abc', createdAt: 1, cwd: '/home/alice/old', isSeeded: false, ...header },
		['{"seq":1,"type":"turn/start"}\n', '{"seq":2,"type":"turn/complete"}\n']);
}

test('readHeader parses the first frame and walks the rest', () => {
	const { header, frames } = readHeader(fixture());
	assert.equal(header.id, 'session-abc');
	assert.equal(header.cwd, '/home/alice/old');
	assert.equal(frames.length, 3);
});

test('rewriteHeaderFrame swaps cwd and keeps every event frame payload', () => {
	const bytes = fixture();
	const out = rewriteHeaderFrame(bytes, '/home/alice/new');
	const { header } = readHeader(out);
	assert.equal(header.cwd, '/home/alice/new');
	assert.equal(header.id, 'session-abc');
	const before = framesText(bytes);
	const after = framesText(out);
	assert.equal(after.length, before.length);
	assert.deepEqual(after.slice(1), before.slice(1), 'event frames must survive the rewrite unchanged');
});

test('rewriteHeaderFrame drops cwd when given undefined', () => {
	const { header } = readHeader(rewriteHeaderFrame(fixture(), undefined));
	assert.equal('cwd' in header, false);
});

test('rewrite keeps unknown header keys and their order', () => {
	const bytes = fixture({ agentPreset: 'standard', delegationDepth: 0, futureField: { nested: true } });
	const { header } = readHeader(rewriteHeaderFrame(bytes, '/new'));
	assert.deepEqual(Object.keys(header), Object.keys(JSON.parse(framesText(bytes)[0].trim())));
	assert.equal(header.agentPreset, 'standard');
	assert.deepEqual(header.futureField, { nested: true });
});

test('large logs stay cheap: only the header frame is re-encoded', () => {
	const events = Array.from({ length: 300 }, (_, index) => `{"seq":${index + 1},"type":"turn/start","payload":"${'x'.repeat(200)}"}\n`);
	const bytes = Buffer.concat([zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id: 'session-big', cwd: '/old' }) + '\n')),
		...events.map(event => zstdCompressSync(Buffer.from(event)))]);
	const out = rewriteHeaderFrame(bytes, '/new');
	const after = framesText(out);
	assert.equal(after.length, 301);
	assert.equal(after[1], events[0]);
	assert.equal(after[300], events[299]);
});

test('a real official artifact (checksummed multi-frame) round-trips', async () => {
	const bytes = await readFile(join(fileURLToPath(import.meta.url), '../../tests/fixtures/session.v4.jsonl.zstd'));
	const { header, frames } = readHeader(bytes);
	assert.equal(header.type, 'session');
	assert.ok(frames.length >= 2, 'the fixture must be multi-frame like the shipped writer');
	const out = rewriteHeaderFrame(bytes, '/moved/target');
	const walked = scanFrames(out);
	assert.equal(walked.length, frames.length);
	const { header: moved } = readHeader(out);
	assert.equal(moved.cwd, '/moved/target');
	assert.equal(moved.id, header.id);
	const before = framesText(bytes), after = framesText(out);
	assert.deepEqual(after.slice(1), before.slice(1));
});

test('garbage is refused loudly', () => {
	assert.throws(() => readHeader(Buffer.from('not-zstd-at-all')), /invalid frame magic/);
	assert.throws(() => scanFrames(Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x40])), /truncated/);
});

test('same cwd produces identical bytes (no rewrite needed)', () => {
	const bytes = fixture();
	assert.ok(rewriteHeaderFrame(bytes, '/home/alice/old').equals(bytes));
});
