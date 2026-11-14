// The protocol client's fixtures (doc/protocol.md): the ChatService `protocol` option over a temporary storage, and a
// turn that returns versions for the person to choose.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { ChatServiceOptions } from '../core/chats';
import type { TurnPlan } from './fakePine';

export const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

/** The `protocol` option over `dir`. */
export function testProtocol(dir: string): NonNullable<ChatServiceOptions['protocol']> {
	return { storage: join(dir, 'protocol') };
}

/** The person's words of a task message: without its first line, `pine-drama-turn <id>` (doc/protocol.md, 4.1). */
export function withoutTask(text: string): string {
	return text.replace(/^pine-drama-turn [\w-]+\n/, '');
}

/** A turn that makes these versions and stops to ask the person to choose them (4.3, `review`). */
export function reviewPlan(targets: readonly { object: string; version: string; files?: Record<string, string>; reason?: string }[]): TurnPlan {
	const files: Record<string, string> = {};
	for (const t of targets) {
		const shown = Object.keys(t.files ?? { 'content.md': '' })[0];
		for (const [name, text] of Object.entries(t.files ?? { 'content.md': t.object })) { files[`drama/${t.object}/${t.version}/${name}`] = text; }
		files[`drama/${t.object}/${t.version}/version.json`] = JSON.stringify({ schema: 1, made_at: '2026-11-12T10:00:00Z', file: shown, inputs: [], prompt: null, from_import: null });
	}
	return { state: 'needs_input', text: 'Please review these exact versions.', files, review: targets.map(t => ({ object: t.object, version: t.version, reason: t.reason ?? 'The driver checked this version.' })) };
}
