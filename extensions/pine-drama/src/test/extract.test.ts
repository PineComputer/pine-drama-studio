import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractText, ideographs, textName, tools } from '../core/extract';

// The text of a Word or PDF screenplay, read on the desktop (ported from open-pinedrama
// src/ui/extract.ts). Fixtures: test-fixtures/extract/README.md.

const fixture = (name: string) => readFileSync(join(__dirname, '../../test-fixtures/extract', name));

test('a .docx gives its raw text, paragraphs and a writer\'s own marks as they are', async () => {
	assert.deepEqual(await extractText('Night Ward.docx', fixture('screenplay.docx')), { complete: true, text: 'EPISODE 1\n\n1-1 DAY INT HOSPITAL CORRIDOR\n\n▲Lin pushes the door open.\n\nLIN: You came.\n\n' });
});

test('a PDF with a text layer gives each page\'s text, a line where pdf.js ends one', async () => {
	assert.deepEqual(await extractText('screenplay.pdf', fixture('screenplay.pdf')), { complete: true, text: 'INT. HOSPITAL CORRIDOR - DAY\nLin opens the door.\nLIN\nYou came.' });
});

test('a PDF with pages that have no text is not offered as text, and names them (a text cover, a scanned body)', async () => {
	assert.deepEqual(await extractText('mixed.pdf', fixture('mixed.pdf')), { complete: false, why: 'pages 2–3 of 3 have no text; they look scanned. Export a text PDF or a .docx' });
});

test('Kangxi radicals become their ideographs, and the text is named after its file', () => {
	assert.equal(ideographs('\u2f00\u2f08'), '\u4e00\u4eba');
	assert.equal(textName('Night Ward.docx'), 'Night Ward.txt');
	assert.equal(textName('draft.PDF'), 'draft.txt');
});

// ---- a legacy Word (.doc) or RTF file, by macOS's textutil (the person attached a .doc) ----

test('a .doc goes to textutil as a file of its own kind, and its text comes back', async t => {
	const real = tools.textutil;
	t.after(() => { tools.textutil = real; });
	const seen: string[] = [];
	tools.textutil = async path => { seen.push(path.split('.').pop()!, readFileSync(path, 'utf8')); return 'EPISODE 1\nLIN: You came…\n'; };
	assert.deepEqual(await extractText('Night Ward.doc', new TextEncoder().encode('DOC BYTES')), { complete: true, text: 'EPISODE 1\nLIN: You came…\n' });
	assert.deepEqual(seen, ['doc', 'DOC BYTES']);
	assert.equal(textName('Night Ward.doc'), 'Night Ward.txt');
	assert.equal(textName('draft.RTF'), 'draft.txt');
	tools.textutil = async () => '  \n';
	assert.deepEqual(await extractText('blank.rtf', new Uint8Array([1])), { complete: false, why: 'it holds no text' });
});

test('an RTF reads with macOS\'s own textutil', { skip: process.platform !== 'darwin' && 'textutil is macOS\'s; the app is macOS-only' }, async () => {
	assert.deepEqual(await extractText('screenplay.rtf', fixture('screenplay.rtf')), { complete: true, text: 'EPISODE 1\nLIN: You came…\n' });
});
