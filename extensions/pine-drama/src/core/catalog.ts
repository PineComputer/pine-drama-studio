// The models the Computer's drama module offers and what a take costs: its catalogue, read inside the Computer with the
// session's own credential (PineSandbox specs/media-provider-api.yaml, getProviderModels, GET /v1/models: "List
// configured model profiles and customer pricing"; pod-local at 127.0.0.1:9410, which the Computer's firewall opens to
// every session user, charts/opensandbox/files/cua-firewall-init.sh). The one source drama-cli itself prices a call
// from (short_drama drama_cli/pine_connection.py, Connection.prepare). Read, never stored. No vscode import.

/** The command that prints the catalogue, run by Pine's exec in the session's shell. */
export const CATALOG_COMMAND = 'curl -sf -H "Authorization: Bearer $PINE_SESSION_TOKEN" -H "X-Pine-Session: $PINE_SESSION" '
	+ 'http://127.0.0.1:9410/modules/media.drama/v1/models';

export interface CatalogModel {
	/** provider:model, as drama-cli's --model takes it. */
	readonly id: string;
	readonly kind: 'image' | 'video' | 'text' | 'asset' | string;
	/** The values Pine admits for each parameter, for example duration and resolution of a video model. */
	readonly parameters: Readonly<Record<string, readonly unknown[]>>;
}

export interface Catalog {
	readonly models: readonly CatalogModel[];
	/** USD per generated second of video, by resolution ("480p"), from the module's price policy. */
	readonly videoUsdPerSecond: Readonly<Record<string, number>>;
}

/** The catalogue in `text`, the JSON GET /v1/models answers; refused when it is not that. */
export function readCatalog(text: string): Catalog {
	const raw = JSON.parse(text) as { models?: Record<string, { kind?: unknown; parameters?: unknown }>; pricing?: { rates?: Record<string, { nano_usd?: unknown; per_units?: unknown }> } };
	if (typeof raw.models !== 'object' || raw.models === null) { throw new Error('the Computer answered no model catalogue'); }
	const models = Object.entries(raw.models).map(([id, entry]) => ({
		id, kind: String(entry.kind ?? ''),
		parameters: (typeof entry.parameters === 'object' && entry.parameters !== null ? entry.parameters : {}) as Record<string, readonly unknown[]>,
	})).sort((a, b) => a.id.localeCompare(b.id));
	// Meters are media.video.<resolution>.generated_ms, priced nano_usd per per_units of milliseconds
	// (PineSandbox components/provider-runtime/pkg/pricing/media.go).
	const videoUsdPerSecond: Record<string, number> = {};
	for (const [meter, rate] of Object.entries(raw.pricing?.rates ?? {})) {
		const resolution = /^media\.video\.(\w+)\.generated_ms$/.exec(meter)?.[1];
		if (resolution && typeof rate.nano_usd === 'number' && typeof rate.per_units === 'number' && rate.per_units > 0) {
			videoUsdPerSecond[resolution] = rate.nano_usd / 1e9 / (rate.per_units / 1000);
		}
	}
	return { models, videoUsdPerSecond };
}

/** The price line of a take of `seconds` at `resolution`, or null when the catalogue prices no such take. */
export function takePrice(catalog: Catalog, seconds: number, resolution: string): string | null {
	const perSecond = catalog.videoUsdPerSecond[resolution];
	return perSecond === undefined ? null : `${seconds} s · ${resolution} · $${(perSecond * seconds).toFixed(2)}`;
}

/** Whether `model` can make a take of `seconds` at `resolution`: Pine admits only the values its profile lists. */
export function takesFit(model: CatalogModel, seconds: number, resolution: string): boolean {
	const durations = model.parameters['duration'];
	const resolutions = model.parameters['resolution'];
	return (!durations || durations.includes(seconds)) && (!resolutions || resolutions.includes(resolution));
}
