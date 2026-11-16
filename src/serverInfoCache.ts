/**
 * What the server list needs from a server's `/v1/server/info`: whether the
 * Plan & Usage button belongs on its row, and its branding logo.
 *
 * Held by the plugin, not by the server list component: the list is mounted
 * again every time the user comes back to it, and a per-mount copy refetched
 * the info each time and inserted the Plan & Usage button after the answer,
 * moving the buttons the user was about to click.
 */
export interface ServerCapabilities {
	billing: boolean;
	logoUrl?: string;
}

/** The subset of `/v1/server/info` the capabilities are derived from. */
export interface ServerInfoLike {
	edition?: string;
	features?: { billing_enabled?: boolean };
	branding?: { logo_url?: string };
}

export function capabilitiesFromInfo(info: ServerInfoLike): ServerCapabilities {
	return {
		billing: info.edition === "enterprise" && info.features?.billing_enabled === true,
		logoUrl: info.branding?.logo_url,
	};
}

interface ServerKey {
	id: string;
	controlPlaneUrl: string;
}

function keyOf(server: ServerKey): string {
	// Editing a server's URL points the same id at another control plane.
	return `${server.id}\u0000${server.controlPlaneUrl}`;
}

export class ServerInfoCache {
	private readonly known = new Map<string, ServerCapabilities>();
	private readonly pending = new Map<string, Promise<ServerCapabilities | null>>();

	/** Capabilities from an earlier answer, or undefined if the server has not answered yet. */
	peek(server: ServerKey): ServerCapabilities | undefined {
		return this.known.get(keyOf(server));
	}

	/** Record an answer obtained elsewhere (login, adding a server). */
	remember(server: ServerKey, info: ServerInfoLike): ServerCapabilities {
		const capabilities = capabilitiesFromInfo(info);
		this.known.set(keyOf(server), capabilities);
		return capabilities;
	}

	/**
	 * Known capabilities, or one request shared by all callers. A failed
	 * request (null) is not remembered, so the next load asks again.
	 */
	load(
		server: ServerKey,
		fetchInfo: (controlPlaneUrl: string) => Promise<ServerInfoLike | null>,
	): Promise<ServerCapabilities | null> {
		const key = keyOf(server);
		const known = this.known.get(key);
		if (known) return Promise.resolve(known);
		const inFlight = this.pending.get(key);
		if (inFlight) return inFlight;
		const request = fetchInfo(server.controlPlaneUrl)
			.catch(() => null)
			.then((info) => (info ? this.remember(server, info) : null))
			.finally(() => this.pending.delete(key));
		this.pending.set(key, request);
		return request;
	}
}
