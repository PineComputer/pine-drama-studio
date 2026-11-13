import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sessionEpisodes } from '../core/sessionEpisodes';

// Session rows name the episodes their most recent turn has files in ("Session rows").

const files: Record<string, string[]> = {};
const rows = (chats: { key: string; state: string }[]) => sessionEpisodes(chats, key => files[key] ?? []);

test('a row names the episodes of its turn\'s files by drama-cli\'s episode identity, and nothing before any file', () => {
	files.a = ['drama/episodes/EP004/breakdown/v1/breakdown.json', 'drama/episodes/EP003/storyboard/v2/shot-01.png', 'drama/episodes/EP003/progress.md'];
	files.none = [];
	// Shared work, and names that only look like an episode, are no episode: an EP id is a folder under episodes/.
	files.shared = ['drama/bible/v3/bible.json', 'drama/assets/props/EP005-poster/v1/image-1.png', 'drama/episodes/EP0012/notes.md', 'episodes/EP006/notes.md'];
	const got = rows([{ key: 'a', state: 'idle' }, { key: 'none', state: 'running' }, { key: 'shared', state: 'idle' }]);
	assert.deepEqual(got.get('a')!.episodes, ['EP003', 'EP004']);
	assert.deepEqual(got.get('none')!.episodes, []);
	assert.deepEqual(got.get('shared')!.episodes, []);
});

test('two running sessions with files in one episode both mark it, naming the other; different episodes, or an ended turn, do not', () => {
	files.a = ['drama/episodes/EP004/breakdown/v1/breakdown.json', 'drama/episodes/EP003/notes.md'];
	files.b = ['drama/episodes/EP004/storyboard/v1/shot-01.png'];
	files.c = ['drama/episodes/EP005/notes.md'];
	files.ended = ['drama/episodes/EP005/notes.md'];
	const got = rows([{ key: 'a', state: 'running' }, { key: 'b', state: 'running' }, { key: 'c', state: 'running' }, { key: 'ended', state: 'idle' }]);
	assert.deepEqual([...got.get('a')!.shared], [['EP004', ['b']]]);
	assert.deepEqual([...got.get('b')!.shared], [['EP004', ['a']]]);
	assert.deepEqual([...got.get('c')!.shared], [], 'EP005\'s other session has ended');
	assert.deepEqual([...got.get('ended')!.shared], []);
});
