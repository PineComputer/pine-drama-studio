import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { test } from 'node:test';
import { assetsBoard } from '../core/assetsCanvas';
import { readProjectFromFolder } from '../core/project';

const FIXTURE = join(__dirname, '..', '..', 'test-fixtures', 'project-v2', 'full');

// The grid frames once dropped every line from the assets canvas, and the person missed them. A variant inside its
// asset's frame is still drawn from its base (`variant_of`), as before the frames.
test('the assets board draws each variant from the object it derives from, inside its frame too', async () => {
	const board = assetsBoard(await readProjectFromFolder(FIXTURE));
	assert.ok(board.links.some(l => l.from === 'assets/characters/lin' && l.to === 'assets/characters/lin/variants/rain'), JSON.stringify(board.links));
	assert.equal(board.stages.find(s => s.id === 'assets/characters/lin/variants/rain')?.section, 'assets/characters/lin', 'in its asset\'s frame');
	assert.deepEqual(board.appearsIn['assets/characters/lin'], ['EP001']);
});
