// The episodes each session row names ("Session rows"): those its most recent turn has
// files in, as the Studio observed them (live reads while it runs, imported files after), by drama-cli's episode identity
// (episodeOf). Nothing is read from chat text. No vscode import.

/** drama-cli's episode identity: EP and three digits. */
const EPISODE = /^episodes\/(EP[0-9]{3})\//;

/** The episode a project-relative path is in, if any. */
export function episodeOf(path: string): string | undefined {
	return EPISODE.exec(path)?.[1];
}

export interface RowEpisodes {
	/** The episodes, sorted; empty before any file is known. */
	readonly episodes: readonly string[];
	/** While the Chat runs: each of its episodes another running Chat's turn also has files in, with those Chats. */
	readonly shared: ReadonlyMap<string, readonly string[]>;
}

/** `files(key)`: the remote paths (`drama/…`) of the Chat's most recent turn (Store.latestTurnFiles). */
export function sessionEpisodes(chats: readonly { key: string; state: string }[], files: (key: string) => readonly string[]): Map<string, RowEpisodes> {
	const of = new Map(chats.map(c => [c.key, [...new Set(files(c.key).flatMap(path => {
		const episode = path.startsWith('drama/') ? episodeOf(path.slice('drama/'.length)) : undefined;
		return episode ? [episode] : [];
	}))].sort()]));
	const running = chats.filter(c => c.state === 'running');
	return new Map(chats.map(c => {
		const shared = new Map<string, string[]>();
		for (const episode of c.state === 'running' ? of.get(c.key)! : []) {
			const others = running.filter(o => o.key !== c.key && of.get(o.key)!.includes(episode)).map(o => o.key);
			if (others.length) { shared.set(episode, others); }
		}
		return [c.key, { episodes: of.get(c.key)!, shared }];
	}));
}
