import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfflineLedger, buildKit } from '../src/cli.mjs';

test('offline rollback can return a session to the no-cwd bucket', async t => {
	const root = await mkdtemp(join(tmpdir(), 'sk-cli-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ledger = new OfflineLedger(join(root, 'workspace.json'));
	await ledger.moveLedger('session-test', undefined, '/target');
	await ledger.moveLedger('session-test', '/target', undefined);
	assert.deepEqual(await ledger.listStoredHeaders(), []);
});

test('offline purge removes registry membership, archive and pin residues', async t => {
	const root = await mkdtemp(join(tmpdir(), 'sk-cli-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const ledger = new OfflineLedger(join(root, 'storages', 'workspace.json'));
	await ledger.moveLedger('session-test', undefined, '/target');
	const kit = buildKit({ dshHome: root, root: join(root, 'kit'), ledger });
	await kit.trash.ledger.write({ version: 1, items: [{ id: 'item', id2: 'session-test', kind: 'session', trashedAt: new Date().toISOString(), snapshot: { sessionId: 'session-test' } }] });
	await kit.action({ type: 'trash.purge', itemId: 'item' });
	assert.deepEqual(await ledger.listStoredHeaders(), []);
});
