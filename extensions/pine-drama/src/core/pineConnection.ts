// Product connection policy. A project key grants access; it is not a human identity.
import { createHash } from 'node:crypto';
import type { PineConnection, SecretVault } from './pinePort';

export const PRODUCTION_ENDPOINT = 'https://pinesandbox.io';
export const PINE_KEY_SECRET = 'pine.projectKey';

export function keyProblem(value: string): string | undefined {
	return value.trim().startsWith('pk_') && !/\s/.test(value.trim()) && value.trim().length > 3
		? undefined : 'Paste a Pine project key beginning with pk_.';
}

/** No secret or upstream exception text is put into a dialog or Output. */
export function connectionFailure(error: unknown): string {
	const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
	if (status === 401 || status === 403) {
		return 'Pine rejected this project key. Check access in Pine Console and try again.';
	}
	return 'Could not verify the Pine connection. Check your network and Pine service availability, then try again.';
}

export function savedConnection(key: string | undefined): PineConnection | undefined {
	if (key === undefined) { return undefined; }
	if (keyProblem(key)) { throw new Error('The saved Pine key is invalid. Disconnect and connect again.'); }
	return { endpoint: PRODUCTION_ENDPOINT, apiKey: key };
}

/** Keep remote handles and history separate if another key is connected later. No existing records are migrated. */
export function connectionScope(pine: PineConnection): string {
	return createHash('sha256').update(JSON.stringify([pine.endpoint, pine.apiKey])).digest('hex');
}

/** The caller supplies the SDK's read-only projectPolicy check, never a Computer creation. */
export async function connectKey(vault: SecretVault, value: string, check: (pine: PineConnection) => Promise<unknown>): Promise<PineConnection> {
	const problem = keyProblem(value);
	if (problem) { throw new Error(problem); }
	const pine = savedConnection(value.trim())!;
	try { await check(pine); } catch (error) { throw new Error(connectionFailure(error)); }
	try { await vault.store(PINE_KEY_SECRET, pine.apiKey); } catch {
		throw new Error('Could not confirm the Pine key was saved to the system credential store. Check the credential store and try again.');
	}
	return pine;
}

/** Only an Extension Development Host may use a launcher's file. Packaged apps ignore every environment override. */
export function developerConnectionFile(development: boolean, named: string | undefined): string | undefined {
	return development && named ? named : undefined;
}

/** Disconnect must not interrupt a tracked worker. Every Computer stops by itself when idle (startIdle), and owed results
 * are collected at the next start (resumeUnfinishedTurnFollowUps); creators get no Computer operation. */
export function disconnectProblem(chats: readonly { computer_state: string; state: string }[]): string | undefined {
	return chats.some(item => item.computer_state === 'running' || item.computer_state === 'creating' || item.state === 'running')
		? 'A Pine Computer is running or starting. It stops by itself after it has been idle; its results are collected the next time the Studio starts with this key.' : undefined;
}
