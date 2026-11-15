import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isPartOf, withoutRepeatedQuestion } from '../core/askedOnce';
import { ChatService, type Update } from '../core/chats';
import type { PineConnection } from '../core/pinePort';
import { Store } from '../core/store';
import { FakePine, MemoryVault } from './fakePine';

// When the agent stops to ask, Pine's result summary and its question are often the same text. The person reads it once.

const ENV: PineConnection = { endpoint: 'http://lvh.me:18080', apiKey: 'pk_test_secret', controlHost: 'api.lvh.me:18080' };
const KEY = 'pine-computer:/local-1';
const QUESTION = 'Before I start: 1. Which preset? 2. Which language?';

function setup() {
	const dir = mkdtempSync(join(tmpdir(), 'pine-asked-'));
	const pine = new FakePine();
	const service = new ChatService({ holdsProject: () => true, turnEndGraceMs: 0, store: new Store(join(dir, 'studio.sqlite')), port: pine, vault: new MemoryVault(), pine: ENV });
	return { pine, service };
}
async function send(service: ChatService, text = 'go'): Promise<string> {
	const out: Update[] = [];
	for await (const update of service.submit(KEY, text, text, [])) {
		out.push(update);
	}
	return out.filter(u => u.kind === 'markdown').map(u => u.text).join('\n');
}
const times = (text: string, part: string) => text.split(part).length - 1;

test('live: a waiting turn\'s question, which is also its result\'s summary, is shown once', async () => {
	const same = setup();
	same.pine.plans = [{ state: 'needs_input', text: QUESTION }];
	const shown = await send(same.service);
	assert.equal(times(shown, QUESTION), 1, shown);
	assert.match(shown, /Your next message answers it/);
});

test('history: the same text shows once under the question; a longer result that holds the question shows once; different texts keep both', () => {
	const m = (kind: string, text: string, turn_id = 't1') => ({ kind, turn_id, text });
	assert.deepEqual(withoutRepeatedQuestion([m('prompt', 'go', 't0'), m('result', QUESTION), m('question', QUESTION)]).map(x => x.kind), ['prompt', 'question']);
	assert.deepEqual(withoutRepeatedQuestion([m('result', `  ${QUESTION}\n`), m('question', QUESTION)]).map(x => x.kind), ['question'], 'whitespace is ignored');
	assert.deepEqual(withoutRepeatedQuestion([m('result', `I checked.\n${QUESTION}`), m('question', QUESTION)]).map(x => x.kind), ['result'], 'the result already says it');
	assert.deepEqual(withoutRepeatedQuestion([m('result', 'Part of it'), m('question', `Part of it, and more?`)]).map(x => x.kind), ['question']);
	assert.deepEqual(withoutRepeatedQuestion([m('result', 'I checked.'), m('question', 'Which preset?')]).map(x => x.kind), ['result', 'question']);
	assert.deepEqual(withoutRepeatedQuestion([m('result', QUESTION, 't1'), m('question', QUESTION, 't2')]).map(x => x.kind), ['result', 'question'], 'another turn is another turn');
	assert.equal(isPartOf('', 'anything'), false);
});
