// Bundles the Studio's webview pages into media/canvas, a script and a stylesheet each, nothing loaded from the network:
// the episode canvas (React + React Flow, spike S11) and the galleries (React).
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'media', 'canvas');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const page of ['canvas', 'gallery', 'seg']) await build({
	entryPoints: [join(root, 'canvas', `${page}.tsx`)],
	bundle: true,
	format: 'iife',
	target: 'es2022',
	minify: true,
	sourcemap: false,
	outfile: join(out, `${page}.js`),
	define: { 'process.env.NODE_ENV': '"production"' },
	loader: { '.ttf': 'file' },
	assetNames: '[name]',
	logLevel: 'warning',
});
