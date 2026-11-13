import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readDrama, type ScopedSnapshot } from '../core/project';
import type { Choices, Snapshot } from '../core/protocol';
import { segEditorModel } from '../core/segEditor';
import { readFromSegEditor, SEG_PROTOCOL } from '../core/segEditorProtocol';

// The seg editor plays a seg's takes itself (core/segEditor.ts, E4), on the protocol fixture (test-fixtures/protocol):
// the rules that, broken, would play a discarded take, the wrong take first, or show one take's request under another.
const FIXTURE = join(__dirname, '..', '..', 'test-fixtures', 'protocol');
const snapshot = (name: string) => JSON.parse(readFileSync(join(FIXTURE, name), 'utf8')) as Snapshot;
const snapshots = (): ScopedSnapshot[] => [{ scope: 'project', snapshot: snapshot('snapshot-project.json') }, { scope: 'episodes', snapshot: snapshot('snapshot-episodes.json') }];
const SEG01 = 'episodes/EP001/segments/seg01';

/** The fixture with seg01's takes v2 and v3 made after its v1, and `choice` as seg01's entry in choices.json. */
function folder(choice: Choices['objects'][string]): string {
	const root = mkdtempSync(join(tmpdir(), 'pds-seg-'));
	cpSync(join(FIXTURE, 'drama'), root, { recursive: true });
	for (const [version, at] of [['v2', '2026-11-12T11:20:00Z'], ['v3', '2026-11-12T11:30:00Z']]) {
		const dir = join(root, ...SEG01.split('/'), version);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, 'version.json'), JSON.stringify({ schema: 1, made_at: at, file: 'video.mp4', inputs: [], prompt: `Take ${version}.`, from_import: null }));
		writeFileSync(join(dir, 'video.mp4'), 'mp4');
	}
	const choices = JSON.parse(readFileSync(join(root, 'choices.json'), 'utf8')) as Choices;
	writeFileSync(join(root, 'choices.json'), JSON.stringify({ ...choices, objects: { ...choices.objects, [SEG01]: choice } }));
	return root;
}

const uri = (file: string) => `webview:${file}`;

test("a seg's takes are its versions the person has not discarded, each with its file and its own request; the newest plays first", async () => {
	const model = segEditorModel(await readDrama(folder({ discarded: ['v2'] }), snapshots), 'EP001', uri);
	const seg = model.segs.find(s => s.id === 'seg01')!;
	assert.deepEqual(seg.takes.map(t => [t.version, t.label, t.src]), [
		['v1', 'Earlier take', `webview:${SEG01}/v1/video.mp4`],
		['v3', 'Waiting for review', `webview:${SEG01}/v3/video.mp4`],
	]);
	assert.equal(seg.shown, 'v3');
	assert.equal(seg.takes.find(t => t.version === 'v3')?.request?.prompt, 'Take v3.', "a take's request is its own version's");
	assert.equal(seg.takes.find(t => t.version === 'v1')?.request?.prompt, 'Image 1 is the first frame. Lin turns from the window.');
	assert.equal(seg.planned, null, 'a seg with a take shows no planned prompt');
});

test('the accepted take plays first; a seg with no take has none, and shows its planned prompt', async () => {
	const model = segEditorModel(await readDrama(folder({ chosen: { version: 'v1', words: 'This take.' } }), snapshots), 'EP001', uri);
	const seg01 = model.segs.find(s => s.id === 'seg01')!;
	assert.equal(seg01.shown, 'v1');
	assert.equal(seg01.takes.find(t => t.version === 'v1')?.label, 'Approved');
	const seg02 = model.segs.find(s => s.id === 'seg02')!;
	assert.deepEqual(seg02.takes, []);
	assert.equal(seg02.shown, null);
	assert.deepEqual(seg02.planned, { by: 'agent', text: 'Lin opens the umbrella in the street.' });
});

test("Generate and Regenerate are the webview's one request to shoot; the seg preview's messages are not read", () => {
	assert.deepEqual(readFromSegEditor({ v: SEG_PROTOCOL, type: 'generate', seg: 'seg01', again: true }), { v: SEG_PROTOCOL, type: 'generate', seg: 'seg01', again: true });
	assert.equal(readFromSegEditor({ v: SEG_PROTOCOL, type: 'generate', seg: 'seg01' }), undefined, 'Generate states whether it is a new take');
	assert.equal(readFromSegEditor({ v: SEG_PROTOCOL, type: 'preview', seg: 'seg01' }), undefined);
	assert.equal(readFromSegEditor({ v: SEG_PROTOCOL, type: 'select', seg: 'seg01' }), undefined);
});
