/**
 * a view refresh pass must judge sign-in per share, against the
 * server the share lives on -- not via the active server's session alone.
 *
 * Reachable state, built through AuthSession's own restore path: two
 * configured servers, the active one signed out, a stored (valid) session
 * for the other. AuthSession.isAuthenticated is false there, yet the user is
 * signed in to the second server and its shares sync. The old gate took every
 * share offline on each refresh pass in that state (and every new file in a
 * folder queues one), with nothing bringing them back -- new files' uploads
 * then sat in the transfer lane, which only drains online shares, for minutes.
 */
import { describe, test, expect, beforeEach } from "@jest/globals";
import { AuthSession, type AuthSettings } from "../src/AuthSession";
import { Settings, SettingsScope } from "../src/SettingsPersistence";
import { TenantRegistry, type TenantSettings } from "../src/TenantRegistry";
import { SystemClock } from "../src/Clock";
import { getAuthStore } from "../src/auth/RelayOnPremAuthStore";
import type { RelayOnPremSettings } from "../src/RelayOnPremConfig";
import { applyShareConnectionGate, type GatedShare } from "../src/shareConnectionGate";

const ACTIVE = "active-server";
const OTHER = "other-server";

class RecordingShare implements GatedShare {
	calls: string[] = [];
	constructor(public readonly config: { onpremServerId?: string }) {}
	goOffline(): void {
		this.calls.push("offline");
	}
	bringOnline(): Promise<boolean> {
		this.calls.push("online");
		return Promise.resolve(true);
	}
}

let appCounter = 0;

async function sessionSignedInTo(serverIds: string[]): Promise<AuthSession> {
	const appId = `gate-8c7a2802-${++appCounter}`;
	const store = getAuthStore(appId);
	for (const serverId of serverIds) {
		store.persist(serverId, {
			user: { id: `u-${serverId}`, email: `user@${serverId}.test` },
			token: `token-${serverId}`,
			expiresAt: Date.now() + 3_600_000,
		});
	}
	const settings = new Settings<unknown>(
		{ loadData: async () => null, saveData: async () => undefined },
		{ login: { provider: undefined }, tenants: {} },
	);
	await settings.hydrate();
	const servers: RelayOnPremSettings = {
		enabled: true,
		defaultServerId: ACTIVE,
		servers: [ACTIVE, OTHER].map((id) => ({
			id,
			name: id,
			controlPlaneUrl: `https://${id}.invalid`,
			isValidated: true,
		})),
	} as RelayOnPremSettings;
	const session = new AuthSession(
		appId,
		async () => undefined,
		new SystemClock(),
		() => undefined,
		new SettingsScope<AuthSettings>(settings, "login"),
		new TenantRegistry(new SettingsScope<TenantSettings>(settings, "tenants")),
		servers,
	);
	await session.waitForRestore();
	return session;
}

describe("view refresh share gate.", () => {
	let otherOpen: RecordingShare;
	let otherClosed: RecordingShare;
	let activeShare: RecordingShare;

	beforeEach(() => {
		otherOpen = new RecordingShare({ onpremServerId: OTHER });
		otherClosed = new RecordingShare({ onpremServerId: OTHER });
		activeShare = new RecordingShare({ onpremServerId: ACTIVE });
	});

	test("signed in to a share's own server but not the active one: its shares stay connected", async () => {
		const session = await sessionSignedInTo([OTHER]);
		expect(session.isAuthenticated).toBe(false);
		expect(session.getCurrentUserForServer(OTHER)).toBeDefined();

		applyShareConnectionGate({
			auth: session,
			serviceOnline: true,
			allShares: [otherOpen, otherClosed, activeShare],
			openShares: [otherOpen],
		});

		expect(otherOpen.calls).toEqual(["online"]);
		expect(otherClosed.calls).toEqual([]);
		// The signed-out server's share is still taken offline.
		expect(activeShare.calls).toEqual(["offline"]);
	});

	test("signed in to the active server: open shares are brought online, none dropped", async () => {
		const session = await sessionSignedInTo([ACTIVE, OTHER]);
		expect(session.isAuthenticated).toBe(true);

		applyShareConnectionGate({
			auth: session,
			serviceOnline: true,
			allShares: [otherOpen, otherClosed, activeShare],
			openShares: [otherOpen, activeShare],
		});

		expect(otherOpen.calls).toEqual(["online"]);
		expect(activeShare.calls).toEqual(["online"]);
		expect(otherClosed.calls).toEqual([]);
	});

	test("service down: every share goes offline, none is brought online", async () => {
		const session = await sessionSignedInTo([ACTIVE, OTHER]);

		applyShareConnectionGate({
			auth: session,
			serviceOnline: false,
			allShares: [otherOpen, otherClosed, activeShare],
			openShares: [otherOpen, activeShare],
		});

		for (const share of [otherOpen, otherClosed, activeShare]) {
			expect(share.calls).toEqual(["offline"]);
		}
	});

	test("share without a server id follows the active-server session", async () => {
		const legacy = new RecordingShare({});
		const signedOutActive = await sessionSignedInTo([OTHER]);
		applyShareConnectionGate({
			auth: signedOutActive,
			serviceOnline: true,
			allShares: [legacy],
			openShares: [legacy],
		});
		expect(legacy.calls).toEqual(["offline"]);

		const legacy2 = new RecordingShare({});
		const signedInActive = await sessionSignedInTo([ACTIVE]);
		applyShareConnectionGate({
			auth: signedInActive,
			serviceOnline: true,
			allShares: [legacy2],
			openShares: [legacy2],
		});
		expect(legacy2.calls).toEqual(["online"]);
	});
});
