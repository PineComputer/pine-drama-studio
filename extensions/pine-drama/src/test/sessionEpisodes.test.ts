import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sessionEpisodes } from '../core/sessionEpisodes';

// Session rows name the episodes their most recent turn has files in ("Session rows").

const files: Record<string, string[]> = {};
const rows = (chats: { key: string }[]) => sessionEpisodes(chats, key => files[key] ?? []);

test('a row names the episodes of its turn\'s files by drama-cli\'s episode identity, and nothing before any file', () => {
	files.a = ['drama/episodes/EP004/breakdown/v1/breakdown.json', 'drama/episodes/EP003/storyboard/v2/shot-01.png', 'drama/episodes/EP003/progress.md'];
	files.none = [];
	// Shared work, and names that only look like an episode, are no episode: an EP id is a folder under episodes/.
	files.shared = ['drama/bible/v3/bible.json', 'drama/assets/props/EP005-poster/v1/image-1.png', 'drama/episodes/EP0012/notes.md', 'episodes/EP006/notes.md'];
	const got = rows([{ key: 'a' }, { key: 'none' }, { key: 'shared' }]);
	assert.deepEqual(got.get('a'), ['EP003', 'EP004']);
	assert.deepEqual(got.get('none'), []);
	assert.deepEqual(got.get('shared'), []);
});

