import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { commandMessage, commandOf } from '../core/commandSend';

test('a command message reads back the argv it was written from, whatever its words hold', () => {
	const argv = ['drama-cli', 'cast', 'sheet', 'li-wei', '--feedback', "it's \"darker\"; $HOME * #1", '--config', 'drama/drama-cli.cfg.yaml'];
	assert.deepEqual(commandOf(commandMessage(argv)), argv);
	assert.equal(commandOf('Draw li-wei again'), null);
	assert.equal(commandOf('$drama-cli models'), null, 'only "$ " with its space starts a command');
});

test('anything beyond words is refused: operators, globs, comments, an empty command', () => {
	for (const text of ['$ drama-cli models; rm -rf x', '$ drama-cli models > out', '$ drama-cli cast sheet *', '$ drama-cli models # note', '$ ']) {
		assert.throws(() => commandOf(text), /runs one program/, text);
	}
});
