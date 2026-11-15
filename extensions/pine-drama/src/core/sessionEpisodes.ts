// The episodes each session row names ("Session rows"): those its most recent turn has
// files in, as the Studio observed them (live reads while it runs, imported files after), by drama-cli's episode identity
// (episodeOf). Nothing is read from chat text. No vscode import.

/** drama-cli's episode identity: EP and three digits. */
const EPISODE = /^episodes\/(EP[0-9]{3})\//;

/** The episode a project-relative path is in, if any. */
export function episodeOf(path: string): string | undefined {
	return EPISODE.exec(path)?.[1];
}

/** `files(key)`: the remote paths (`drama/…`) of the Chat's most recent turn (Store.latestTurnFiles). Each Chat's episodes, sorted; empty before any file is known. */
export function sessionEpisodes(chats: readonly { key: string }[], files: (key: string) => readonly string[]): Map<string, readonly string[]> {
	return new Map(chats.map(c => [c.key, [...new Set(files(c.key).flatMap(path => {
		const episode = path.startsWith('drama/') ? episodeOf(path.slice('drama/'.length)) : undefined;
		return episode ? [episode] : [];
	}))].sort()]));
}
