/**
 * "Use server version" on a note that is not open in an editor.
 *
 * Live on the 0.1.36 candidate (Verity, 3/3): A replaced the text, A's Y.Doc
 * and disk had the sync copy, B kept the old text for good. liveTextTarget
 * set the text in A's Y.Doc while that document had no relay connection, and
 * nothing connected it soon: the background sweep visits a closed note once
 * per 15 min pass, and A's own change marker only sends OTHER clients to pull.
 *
 * The relay here is a second Y.Doc that receives A's updates only while A's
 * document is connected, and B is a third that syncs from the relay. Updates
 * made before connecting are deliberately NOT replayed on connect: the fix
 * must not depend on the handshake carrying them.
 */

import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import { TFile } from "obsidian";

jest.mock("src/Document", () => ({
	isDocument: (file?: { __isDocument?: boolean }) => file?.__isDocument === true,
}));
jest.mock("src/CanvasDocument", () => ({
	isCanvasDocument: () => false,
}));
jest.mock("src/ResourceAddress", () => ({
	ResourceAddress: { serialize: () => "relay:doc" },
}));

import {
	liveTextTarget,
	TAKE_SERVER_CONNECT_ROUNDS,
	TAKE_SERVER_CONNECT_TIMEOUT_MS,
} from "src/outboundSyncWiring";

const VAULT_PATH = "Team/fc.md";
const LIVE = "C1 first device\nC2 first device\nC3 first device\n";
const SYNC_COPY = "C1 first device\nC2 changed on the server side\n";
const THIRD = "C4 added by a third member\n";
/** Long enough for every retry, flush and timeout in liveTextTarget. */
const RUN_MS = 120_000;

const flushPromises = () => new Promise<void>((resolve) => setImmediate(resolve));

class FakeClock {
	private t = 0;
	private timers = new Map<number, { at: number; fn: () => void }>();
	private nextId = 1;
	now = (): number => this.t;
	scheduleTimeout = (fn: () => void, ms: number): number => {
		const id = this.nextId++;
		this.timers.set(id, { at: this.t + ms, fn });
		return id;
	};
	cancelTimeout = (id: number): void => {
		this.timers.delete(id);
	};
	async advance(ms: number): Promise<void> {
		const end = this.t + ms;
		await flushPromises();
		for (;;) {
			const due = Array.from(this.timers.entries())
				.filter(([, timer]) => timer.at <= end)
				.sort((a, b) => a[1].at - b[1].at)[0];
			if (!due) break;
			this.timers.delete(due[0]);
			this.t = Math.max(this.t, due[1].at);
			due[1].fn();
			for (let i = 0; i < 5; i++) await flushPromises();
		}
		this.t = end;
		for (let i = 0; i < 5; i++) await flushPromises();
	}
}

function textOf(doc: Y.Doc): string {
	return doc.getText("contents").toString();
}

/** Adds a line to the relay that this device has never seen (another member's edit). */
function thirdMemberAdds(relay: Y.Doc): void {
	const other = new Y.Doc();
	Y.applyUpdate(other, Y.encodeStateAsUpdate(relay));
	other.getText("contents").insert(LIVE.length, THIRD);
	Y.applyUpdate(relay, Y.encodeStateAsUpdate(other, Y.encodeStateVector(relay)));
}

/**
 * coldConnects: how many connects the relay answers off an empty placeholder
 * of a room it is still loading.: no stored text is sent and the
 * announced state vector is empty; what the client sends still merges into
 * the stored room once it loads. drainMs: how long sent bytes sit in the
 * socket's send buffer; closing the socket before that loses them.
 */
function stand(
	opts: {
		open?: boolean;
		connects?: boolean;
		syncs?: boolean;
		coldConnects?: number;
		drainMs?: number;
		/** The note has never had any text, on the relay or on this device. */
		empty?: boolean;
	} = {},
) {
	const { open = false, connects = true, syncs = true, coldConnects = 0, drainMs = 0, empty = false } = opts;
	const relay = new Y.Doc();
	if (!empty) relay.getText("contents").insert(0, LIVE);
	const a = new Y.Doc();
	Y.applyUpdate(a, Y.encodeStateAsUpdate(relay));
	const b = new Y.Doc();
	Y.applyUpdate(b, Y.encodeStateAsUpdate(relay));
	const clock = new FakeClock();

	let connected = open;
	let connectCount = 0;
	let outbox: Uint8Array[] = [];
	let drainTimer: number | null = null;
	const ws = {
		get bufferedAmount() {
			return outbox.reduce((sum, update) => sum + update.length, 0);
		},
	};
	const liveProvider = {
		ws,
		relayStateVector: (open ? Y.encodeStateVector(relay) : null) as Uint8Array | null,
	};
	const deliver = () => {
		for (const update of outbox) Y.applyUpdate(relay, update, "relay");
		outbox = [];
		drainTimer = null;
	};
	a.on("update", (update: Uint8Array, origin: unknown) => {
		if (!connected || origin === "relay") return;
		outbox.push(update);
		if (drainMs === 0) deliver();
		else if (drainTimer === null) drainTimer = clock.scheduleTimeout(deliver, drainMs);
	});
	const goOffline = jest.fn(() => {
		connected = false;
		// Closing the socket discards whatever is still buffered.
		outbox = [];
		if (drainTimer !== null) clock.cancelTimeout(drainTimer);
		drainTimer = null;
	});
	const bringOnline = jest.fn(async () => {
		if (!connects) return false;
		connected = true;
		connectCount++;
		if (connectCount <= coldConnects) {
			liveProvider.relayStateVector = Y.encodeStateVector(new Y.Doc());
		} else {
			liveProvider.relayStateVector = Y.encodeStateVector(relay);
			Y.applyUpdate(a, Y.encodeStateAsUpdate(relay, Y.encodeStateVector(a)), "relay");
		}
		return true;
	});
	const dropFromQueue = jest.fn();
	const setSyncBase = jest.fn(async (_text: string) => undefined);
	const entry = {
		setSyncBase,
		__isDocument: true,
		crdtDoc: a,
		editLock: false,
		_liveProvider: liveProvider,
		get isOnline() {
			return connected;
		},
		connectionIntent: open ? "connected" : "disconnected",
		awaitFirstSync: async () => undefined,
		bringOnline,
		onceFreshlySynced: () => (syncs ? Promise.resolve() : new Promise<void>(() => undefined)),
		goOffline,
		resourceAddress: {},
		vaultShare: { credentialCache: { dropFromQueue } },
	};
	const vault = {
		getAbstractFileByPath: (path: string) => new (TFile as unknown as new (path: string) => TFile)(path),
	};
	const shareRegistry = { shareFor: () => ({ rootRelative: { entryFor: () => entry } }) };
	const target = () =>
		liveTextTarget(vault as never, shareRegistry as never, clock as never, VAULT_PATH);
	/** B pulls whatever the relay has (the poller's connect). */
	const bPulls = () => Y.applyUpdate(b, Y.encodeStateAsUpdate(relay, Y.encodeStateVector(b)));
	return { relay, a, b, entry, clock, target, bPulls, goOffline, bringOnline, dropFromQueue, setSyncBase };
}

/** Runs `work` while the fake clock moves; resolves to its result or its error message. */
async function run<T>(s: ReturnType<typeof stand>, work: () => Promise<T>): Promise<T | string> {
	const settled = work().then(
		(value) => value,
		(err: Error) => err.message,
	);
	await s.clock.advance(RUN_MS);
	return settled;
}

async function replaceAndRelease(s: ReturnType<typeof stand>) {
	const outcome = await run(s, async () => {
		const live = await s.target();
		expect(live).not.toBeNull();
		await live!.replace(SYNC_COPY);
		live!.release();
		return "done";
	});
	expect(outcome).toBe("done");
}

describe("Use server version on a closed note reaches the relay.", () => {
	test("the relay and the other member get the sync copy; the connection opened for it is dropped", async () => {
		const s = stand();

		await replaceAndRelease(s);
		s.bPulls();

		expect(textOf(s.a)).toBe(SYNC_COPY);
		expect(textOf(s.relay)).toBe(SYNC_COPY);
		expect(textOf(s.b)).toBe(SYNC_COPY);
		expect(s.bringOnline).toHaveBeenCalledTimes(1);
		expect(s.goOffline).toHaveBeenCalledTimes(1);
		expect(s.dropFromQueue).toHaveBeenCalledWith("relay:doc");
		expect(s.entry.isOnline).toBe(false);
		// The next closed-file edit compares against this, not the old base.
		expect(s.setSyncBase).toHaveBeenCalledWith(SYNC_COPY);
	});

	test("the diff is taken against the relay's current text, not this device's stale copy", async () => {
		const s = stand();
		thirdMemberAdds(s.relay);

		await replaceAndRelease(s);
		s.bPulls();

		expect(textOf(s.relay)).toBe(SYNC_COPY);
		expect(textOf(s.b)).toBe(SYNC_COPY);
	});

	test("a relay room still loading is reconnected before anything changes, so no member gets mixed text", async () => {
		const s = stand({ coldConnects: 2 });
		thirdMemberAdds(s.relay);

		await replaceAndRelease(s);
		s.bPulls();

		expect(textOf(s.relay)).toBe(SYNC_COPY);
		expect(textOf(s.b)).toBe(SYNC_COPY);
		expect(s.bringOnline).toHaveBeenCalledTimes(3);
		expect(s.entry.isOnline).toBe(false);
	});

	test("a relay room that never loads: throws before anything changes", async () => {
		const s = stand({ coldConnects: Number.MAX_SAFE_INTEGER });
		thirdMemberAdds(s.relay);

		const outcome = await run(s, () => s.target());

		expect(outcome).toMatch("still loading");
		expect(s.bringOnline).toHaveBeenCalledTimes(TAKE_SERVER_CONNECT_ROUNDS);
		expect(textOf(s.a)).toBe(LIVE);
		expect(textOf(s.relay)).toBe(LIVE + THIRD);
		expect(s.setSyncBase).not.toHaveBeenCalled();
		expect(s.entry.isOnline).toBe(false);
	});

	test("an empty room on an empty note is taken as empty after the retries, not as loading", async () => {
		const s = stand({ empty: true, coldConnects: Number.MAX_SAFE_INTEGER });

		await replaceAndRelease(s);
		s.bPulls();

		expect(s.bringOnline).toHaveBeenCalledTimes(TAKE_SERVER_CONNECT_ROUNDS);
		expect(textOf(s.relay)).toBe(SYNC_COPY);
		expect(textOf(s.b)).toBe(SYNC_COPY);
	});

	test("an editor opened while the room is loading keeps its connection; nothing changes", async () => {
		const s = stand({ coldConnects: 1 });
		const connect = s.bringOnline.getMockImplementation()!;
		s.bringOnline.mockImplementationOnce(async () => {
			const connected = await connect();
			s.entry.editLock = true;
			return connected;
		});

		const outcome = await run(s, () => s.target());

		expect(outcome).toMatch("opened while the relay was loading");
		expect(s.goOffline).not.toHaveBeenCalled();
		expect(textOf(s.a)).toBe(LIVE);
		expect(textOf(s.relay)).toBe(LIVE);
	});

	test("a slow send buffer is drained before the connection closes", async () => {
		const s = stand({ drainMs: 3_000 });

		await replaceAndRelease(s);
		s.bPulls();

		expect(textOf(s.relay)).toBe(SYNC_COPY);
		expect(textOf(s.b)).toBe(SYNC_COPY);
		expect(s.goOffline).toHaveBeenCalledTimes(1);
	});

	test("a note open in an editor is changed on its own connection and stays connected", async () => {
		const s = stand({ open: true });

		await replaceAndRelease(s);

		expect(textOf(s.relay)).toBe(SYNC_COPY);
		expect(s.bringOnline).not.toHaveBeenCalled();
		expect(s.goOffline).not.toHaveBeenCalled();
		expect(s.setSyncBase).toHaveBeenCalledWith(SYNC_COPY);
	});

	test("an editor opened during the replacement keeps its connection", async () => {
		const s = stand();
		const outcome = await run(s, async () => {
			const live = await s.target();
			s.entry.editLock = true;
			await live!.replace(SYNC_COPY);
			live!.release();
			live!.release();
			return "done";
		});

		expect(outcome).toBe("done");
		expect(textOf(s.relay)).toBe(SYNC_COPY);
		expect(s.goOffline).not.toHaveBeenCalled();
	});

	test("no connection: throws before anything changes", async () => {
		const s = stand({ connects: false });

		const outcome = await run(s, () => s.target());

		expect(outcome).toMatch("relay did not answer");
		expect(s.setSyncBase).not.toHaveBeenCalled();
		expect(textOf(s.a)).toBe(LIVE);
		expect(textOf(s.relay)).toBe(LIVE);
		expect(s.goOffline).toHaveBeenCalledTimes(1);
	});

	test("connected but never synced: throws after the timeout and drops the connection", async () => {
		const s = stand({ syncs: false });

		const outcome = await run(s, () => s.target());

		expect(outcome).toMatch("relay did not answer");
		expect(TAKE_SERVER_CONNECT_TIMEOUT_MS).toBeLessThan(RUN_MS);
		expect(textOf(s.a)).toBe(LIVE);
		expect(s.goOffline).toHaveBeenCalledTimes(1);
		expect(s.entry.isOnline).toBe(false);
	});
});
