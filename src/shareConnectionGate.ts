/**
 * Which shares a view refresh pass may keep connected.
 *
 * Sign-in is judged per share, against the server the share lives on. The
 * global `AuthSession.isAuthenticated` only reflects the ACTIVE server's
 * session, so gating on it took every share offline whenever the user was
 * signed in to a share's own server but not to the active one -- on every
 * refresh pass, and every new file in a folder queues one. Nothing on that
 * path brings a share back, so uploads for new files sat parked in the
 * transfer lane (it only drains online shares) for minutes.
 *
 * Kept free of Obsidian/CodeMirror imports so the rule is testable on its own;
 * ViewBindings.ts is the only caller.
 */

export interface ShareSignInSource {
	getCurrentUserForServer(serverId?: string): unknown;
}

export interface GatedShare {
	readonly config: { onpremServerId?: string };
	goOffline(): void;
	bringOnline(): Promise<boolean>;
}

/** True when the user is signed in to the server this share lives on. A share
 * without a server id falls back to the active-server session, the legacy
 * single-server assumption VaultShare's constructor also makes for restored
 * folders. getCurrentUserForServer stays defined while an expired access token
 * is being refreshed (the provider keeps returning the old token), so the gate
 * is as sticky as the active-server `currentUser` check it replaces. */
export function isSignedInForShare(auth: ShareSignInSource, share: GatedShare): boolean {
	return auth.getCurrentUserForServer(share.config.onpremServerId) !== undefined;
}

/**
 * Service down: every share goes offline. Service up: a share whose server the
 * user is not signed in to goes offline; shares with an open view on a
 * signed-in server are brought online; the rest are left as they are.
 */
export function applyShareConnectionGate(args: {
	auth: ShareSignInSource;
	serviceOnline: boolean;
	allShares: Iterable<GatedShare>;
	openShares: Iterable<GatedShare>;
}): void {
	const { auth, serviceOnline } = args;
	for (const share of args.allShares) {
		if (!serviceOnline || !isSignedInForShare(auth, share)) {
			share.goOffline();
		}
	}
	if (!serviceOnline) return;
	for (const share of args.openShares) {
		if (isSignedInForShare(auth, share)) {
			void share.bringOnline();
		}
	}
}
