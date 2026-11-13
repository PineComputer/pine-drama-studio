import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetsBoard } from '../core/assetsCanvas';
import { readDrama, type ScopedSnapshot } from '../core/project';
import type { Snapshot } from '../core/protocol';

const FIXTURE = join(__dirname, '..', '..', 'test-fixtures', 'protocol');
const snapshot = (name: string): ScopedSnapshot => ({ scope: name.includes('episodes') ? 'episodes' : 'project', task: name,
	snapshot: JSON.parse(readFileSync(join(FIXTURE, name), 'utf8')) as Snapshot, sent: '2026-11-12T13:00:00Z', installed: '2026-11-12T13:01:00Z' });

// The grid frames once dropped every line from the assets canvas, and the person missed them. A variant inside its
// asset's frame is still drawn from its base (`variant_of`), as before the frames.
test('the assets board draws each variant from the object it derives from, inside its frame too', async () => {
	const drama = await readDrama(join(FIXTURE, 'drama'), () => [snapshot('snapshot-project.json'), snapshot('snapshot-episodes.json')]);
	const board = assetsBoard(drama);
	assert.ok(board.links.some(l => l.from === 'assets/characters/lin' && l.to === 'assets/characters/lin/variants/rain'), JSON.stringify(board.links));
	assert.equal(board.stages.find(s => s.id === 'assets/characters/lin/variants/rain')?.section, 'assets/characters/lin', 'in its asset\'s frame');
});
