# Extraction fixtures

Made by hand for `src/test/extract.test.ts`, with no tool but Python's `zipfile`:

- `screenplay.docx`: a minimal Word file (ECMA-376 parts: `[Content_Types].xml`, `_rels/.rels`, `word/document.xml`) with four paragraphs in a writer's own form (a `▲` action mark).
- `screenplay.pdf`: a two-page PDF 1.4 with a text layer (Helvetica, ISO 32000-1).
- `mixed.pdf`: a text cover and two pages with no text, as a scanned body would be.
- `screenplay.rtf`: two lines, one with an RTF Unicode escape (`\uN?`), as Word and TextEdit write them; read by macOS's textutil.
