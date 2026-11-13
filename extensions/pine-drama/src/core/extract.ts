// The text of a Word or PDF screenplay, read on the desktop. drama-cli reads a screenplay
// only as UTF-8 text (_read_bytes), so the Studio sends a .docx's or a PDF's text beside
// the file, which it keeps. Ported from open-pinedrama `redesign/docs` (261d864) src/ui/extract.ts: mammoth's raw text
// of a .docx (1.13.0) and pdf.js's text of each page, a line break where pdf.js marks an end of line (6.4.299), with
// Kangxi radicals mapped to their ideographs and nothing else normalized. Two differences, each for a reason:
// - It runs in the extension host, in Node: mammoth takes a buffer, and pdf.js is its Node legacy build
//   (open question 3), whose worker runs in the same process.
// - Every page is accounted for: a PDF with a text cover and a scanned body gave v1 only the
//   cover, reported as a success. Pages with no text make the extraction incomplete, and they are named.
// A legacy Word file (.doc) or an RTF file is read by macOS's own textutil (`tools.textutil`), added after a person
// attached a .doc; it is macOS-only, as the app is today, and said where it cannot run.
// No model is used and no structure is guessed. No vscode import.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';

/** Word, PDF and RTF files, whose text is read with a parser (a legacy .doc and an .rtf by macOS's textutil). */
export const EXTRACTED = /\.(docx|pdf|doc|rtf)$/i;

/**
 * A legacy Word (.doc) or RTF file's text, by macOS's own converter: `textutil -convert txt -stdout` (man textutil),
 * run with its arguments, never through a shell. The app is macOS-only today; elsewhere (CI on Linux) a test sets this.
 */
export const tools = {
	textutil: (path: string): Promise<string> => new Promise((resolve, reject) => {
		if (process.platform !== 'darwin') {
			reject(new Error('reading a .doc or .rtf needs macOS (textutil)'));
			return;
		}
		execFile('/usr/bin/textutil', ['-convert', 'txt', '-encoding', 'UTF-8', '-stdout', path], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
			if (error) {
				reject(error);
			} else {
				resolve(stdout);
			}
		});
	}),
};

/** The file name of a Word or PDF file's text: its stem with .txt. */
export function textName(name: string): string {
	return name.replace(EXTRACTED, '.txt');
}

export type Extraction =
	| { readonly complete: true; readonly text: string }
	| { readonly complete: false; readonly why: string };

/** A PDF's Kangxi radicals (U+2F00 for U+4E00) take their compatibility decomposition, the unified ideograph (U+2F00–U+2FD5). */
export function ideographs(text: string): string {
	return text.replace(/[⼀-⿕]/g, radical => radical.normalize('NFKC'));
}

/** Page numbers as a short list: "2–31" or "2, 5". */
function pageList(pages: readonly number[]): string {
	const runs: string[] = [];
	for (let i = 0; i < pages.length; i++) {
		let j = i;
		while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) {
			j++;
		}
		runs.push(i === j ? `${pages[i]}` : `${pages[i]}–${pages[j]}`);
		i = j;
	}
	return runs.join(', ');
}

/** The text of a .docx or .pdf file, or why it cannot be offered as the text drama-cli reads. */
export async function extractText(name: string, data: Uint8Array): Promise<Extraction> {
	if (/\.docx$/i.test(name)) {
		const mammoth = await import('mammoth');
		const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data) });
		return value.trim() ? { complete: true, text: value } : { complete: false, why: 'it holds no text' };
	}
	if (/\.(doc|rtf)$/i.test(name)) {
		// textutil reads a file: the bytes are written to a private temporary folder and removed after.
		const folder = mkdtempSync(join(tmpdir(), 'pine-extract-'));
		try {
			const path = join(folder, `input${extname(name).toLowerCase()}`);
			writeFileSync(path, data);
			const text = await tools.textutil(path);
			return text.trim() ? { complete: true, text } : { complete: false, why: 'it holds no text' };
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	}
	if (/\.pdf$/i.test(name)) {
		const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
		// pdf.js takes the bytes over: give it a copy. Its CMaps read the text of Chinese CID fonts, and its standard fonts
		// the 14 base fonts a PDF need not embed; both ship in the package (pdfjs-dist cmaps/, standard_fonts/).
		const root = dirname(require.resolve('pdfjs-dist/package.json'));
		const task = pdfjs.getDocument({ data: new Uint8Array(data), cMapUrl: `${join(root, 'cmaps')}/`, cMapPacked: true, standardFontDataUrl: `${join(root, 'standard_fonts')}/` });
		const document = await task.promise;
		const pages: string[] = [];
		const empty: number[] = [];
		try {
			for (let number = 1; number <= document.numPages; number += 1) {
				const content = await (await document.getPage(number)).getTextContent();
				const text = content.items.map(item => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join('');
				pages.push(text);
				if (!text.trim()) {
					empty.push(number);
				}
			}
		} finally {
			await task.destroy();
		}
		if (empty.length) {
			return { complete: false, why: `${empty.length === 1 ? 'page' : 'pages'} ${pageList(empty)} of ${pages.length} ${empty.length === 1 ? 'has' : 'have'} no text; ${empty.length === 1 ? 'it looks' : 'they look'} scanned. Export a text PDF or a .docx` };
		}
		return { complete: true, text: ideographs(pages.join('\n')) };
	}
	throw new Error(`not a Word, PDF or RTF file: ${name}`);
}
