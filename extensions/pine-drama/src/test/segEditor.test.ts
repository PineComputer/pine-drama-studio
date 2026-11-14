import { strict as assert } from 'node:assert';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readProjectFromFolder } from '../core/project';
import { segEditorModel } from '../core/segEditor';
import { readFromSegEditor, SEG_PROTOCOL } from '../core/segEditorProtocol';

// The seg editor's model (core/segEditor.ts) on the major-2 fixture (test-fixtures/project-v2): the rules that, broken,
// would play no take where one is shot, show one take's receipt under another, or hide a seg's prompt before its take.
const FIXTURES = join(__dirname, '..', '..', 'test-fixtures', 'project-v2');
const uri = (file: string) => `webview:${file}`;
const model = async (name: 'full' | 'after-bible') => {
	const root = mkdtempSync(join(tmpdir(), 'pds-seg-'));
	cpSync(join(FIXTURES, name), root, { recursive: true });
	return segEditorModel(root, await readProjectFromFolder(root), 'EP001', uri);
};

test("a shot seg plays its take, with what it was made with; a seg not shot shows its prompt and says so", async () => {
	const full = await model('full');
	assert.deepEqual(full.segs.map(s => s.id), ['seg01', 'seg02']);
	const [seg01, seg02] = full.segs;
	assert.deepEqual([seg01.take, seg01.src, seg01.badge], ['episodes/EP001/segments/seg01', 'webview:episodes/EP001/segments/seg01/take.mp4', '']);
	assert.equal(seg01.request?.prompt, 'Image 1 is the first frame. Lin turns from the window.', "the take's own receipt");
	assert.deepEqual(seg01.poster, { media: 'video', src: 'webview:episodes/EP001/segments/seg01/take.mp4' });
	assert.deepEqual([seg02.src, seg02.request, seg02.prompt, seg02.badge], [null, null, 'Lin opens the umbrella in the street.\n', 'Not shot yet']);
	assert.equal(full.cut, null, 'no cut yet');
});

test('an episode with no segs yet has none, as right after the bible', async () => {
	const bible = await model('after-bible');
	assert.deepEqual([bible.segs, bible.cut], [[], null]);
});

test("Generate and Regenerate are the webview's one request to shoot; the seg preview's messages are not read", () => {
	assert.deepEqual(readFromSegEditor({ v: SEG_PROTOCOL, type: 'generate', seg: 'seg01', again: true }), { v: SEG_PROTOCOL, type: 'generate', seg: 'seg01', again: true });
	assert.equal(readFromSegEditor({ v: SEG_PROTOCOL, type: 'generate', seg: 'seg01' }), undefined, 'Generate states whether it is a new take');
	assert.equal(readFromSegEditor({ v: SEG_PROTOCOL, type: 'preview', seg: 'seg01' }), undefined);
	assert.equal(readFromSegEditor({ v: SEG_PROTOCOL, type: 'select', seg: 'seg01' }), undefined);
});
