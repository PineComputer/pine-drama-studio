import { strict as assert } from 'node:assert';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readChoices, readVersions, resolve, updateChoices, withObject, writeWhole } from '../core/choices';
import { Holders } from '../core/taskArtifacts';
import { check, ProtocolDocumentError, UnsupportedMajor, type Choices } from '../core/protocol';

// The protocol's rules that can lose the person's decision (doc/protocol.md, section 3.2), on a fixture drama in protocol
// form (test-fixtures/protocol/README.md).
const FIXTURE = join(__dirname, '..', '..', 'test-fixtures', 'protocol');

async function copy(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'choices-'));
	await cp(join(FIXTURE, 'drama'), dir, { recursive: true });
	return dir;
}

test('accepted is never simply the newest: an unreviewed newer version is current, the reviewed one stays accepted', async () => {
	const root = await copy();
	try {
		const lin = resolve(await readVersions(root, 'assets/characters/lin'), null, 'assets/characters/lin');
		assert.deepEqual([lin.current, lin.accepted, lin.acceptedBy], ['v2', 'v1', 'agent']);
		const umbrella = resolve(await readVersions(root, 'assets/props/umbrella'), null, 'assets/props/umbrella');
		assert.deepEqual([umbrella.current, umbrella.accepted], ['v1', null]);
	} finally { await rm(root, { recursive: true }); }
});

test('the person wins: chosen over reviews, a review with their words over the agent, a discarded or removed choice is no choice', async () => {
	const root = await copy();
	try {
		const versions = await readVersions(root, 'assets/characters/lin');
		const choices = (objects: Choices['objects']): Choices => ({ schema: 1, objects, added: [], imports: [] });
		const chosen = resolve(versions, choices({ 'assets/characters/lin': { chosen: { version: 'v2', words: 'Yes.' } } }), 'assets/characters/lin');
		assert.deepEqual([chosen.current, chosen.accepted, chosen.acceptedBy], ['v2', 'v2', 'person']);
		const discarded = resolve(versions, choices({ 'assets/characters/lin': { chosen: { version: 'v2' }, discarded: ['v2'] } }), 'assets/characters/lin');
		assert.deepEqual([discarded.current, discarded.accepted, discarded.acceptedBy], ['v1', 'v1', 'agent']);
		const removed = resolve(versions, choices({ 'assets/characters/lin': { chosen: { version: 'v2' }, removed: true } }), 'assets/characters/lin');
		assert.equal(removed.removed, true);
		assert.equal(removed.accepted, 'v1', 'a removed object keeps no choice');
		const personReview = versions.map(v => v.id === 'v2' ? { ...v, reviews: [{ schema: 1 as const, accepted_at: '2026-11-12T09:40:00Z', reason: 'r', person: 'Good.' }] } : v);
		const byWords = resolve(personReview, null, 'assets/characters/lin');
		assert.deepEqual([byWords.accepted, byWords.acceptedBy], ['v2', 'person']);
		assert.equal(chosen.needsWords(versions[1]), true, 'an unreviewed version needs the person\'s words');
		assert.equal(chosen.needsWords(versions[0]), false, 'a reviewed version does not');
	} finally { await rm(root, { recursive: true }); }
});

test('an import is the person\'s own and resolves once its version exists', async () => {
	const root = await copy();
	try {
		const office = resolve(await readVersions(root, 'assets/scenes/office'), await readChoices(root), 'assets/scenes/office');
		assert.deepEqual([office.current, office.accepted, office.acceptedBy], ['v1', 'v1', 'person']);
		assert.equal(office.needsWords((await readVersions(root, 'assets/scenes/office'))[0]), false);
	} finally { await rm(root, { recursive: true }); }
});

test('choices.json is written whole: a change lands, an invalid one leaves the file as it was, and no temporary file stays', async () => {
	const root = await copy();
	try {
		await updateChoices(root, c => withObject(c, 'assets/characters/lin', e => ({ ...e, discarded: ['v2'] })));
		const before = await readFile(join(root, 'choices.json'), 'utf8');
		assert.deepEqual((await readChoices(root))?.objects['assets/characters/lin'], { discarded: ['v2'] });
		await assert.rejects(updateChoices(root, c => withObject(c, 'assets/characters/lin', () => ({ chosen: {} }))), ProtocolDocumentError);
		assert.equal(await readFile(join(root, 'choices.json'), 'utf8'), before);
		assert.deepEqual((await readdir(root)).filter(n => n.endsWith('.tmp')), []);
	} finally { await rm(root, { recursive: true }); }
});

test('another major is refused whole, before any other check', () => {
	assert.throws(() => check('choices', { schema: 2, objects: {}, added: [], imports: [] }, 'choices.json'), UnsupportedMajor);
});

test('a choice without the words it needs, or naming a version the client lacks, is no choice', () => {
	const version = (id: string, reviewed: boolean) => ({ id, record: { schema: 1 as const, made_at: '2026-11-12T09:00:00Z', file: null, inputs: [], prompt: null, from_import: null },
		reviews: reviewed ? [{ schema: 1 as const, accepted_at: '2026-11-12T09:01:00Z', reason: 'ok' }] : [] });
	const versions = [version('v1', true), version('v2', false)];
	const choices = (chosen: Choices['objects'][string]['chosen']): Choices => ({ schema: 1, objects: { o: { chosen } }, added: [], imports: [] });
	assert.equal(resolve(versions, choices({ version: 'v2' }), 'o').accepted, 'v1', 'v2 needs words: the agent\'s review stands');
	assert.equal(resolve(versions, choices({ version: 'v2', words: 'Yes.' }), 'o').accepted, 'v2');
	assert.equal(resolve(versions, choices({ version: 'v7', words: 'Yes.' }), 'o').current, 'v2', 'an unknown version is no choice');
});

// B9: two sessions preparing at once record holders in one folder at the same moment. Each write's temporary file must
// be its own: when two shared a name, one rename found the file gone ("ENOENT … holders/.<pid>.<ms>.tmp") and the
// other could put one write's bytes under the other's name.
test('writes started together in one folder each land whole, under their own name', async t => {
	const dir = await mkdtemp(join(tmpdir(), 'write-whole-'));
	// One millisecond for every write, so that a name made of the time can only collide.
	t.mock.method(Date, 'now', () => 1_794_573_115_577);
	const names = Array.from({ length: 20 }, (_, i) => `file-${i}`);
	await Promise.all(names.map(name => writeWhole(join(dir, name), `text of ${name}`)));
	for (const name of names) {
		assert.equal(await readFile(join(dir, name), 'utf8'), `text of ${name}`);
	}
	assert.deepEqual((await readdir(dir)).sort(), [...names].sort(), 'no temporary file is left');
	const holders = new Holders(join(dir, 'holders'));
	await Promise.all([holders.set(['a', 'b'], 'computer-1'), holders.set(['c', 'd'], 'computer-2')]);
	assert.deepEqual(['a', 'b', 'c', 'd'].map(hash => holders.get(hash)), ['computer-1', 'computer-1', 'computer-2', 'computer-2']);
});
