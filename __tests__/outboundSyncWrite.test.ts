/**
 * Obsidian -> sync protocol.
 *
 * A local edit or a new note used to reach only the CRDT, so files-index /
 * download (what external clients read) never saw it. These tests pin:
 *   1. the decision table local / base / server / origin;
 *   2. the outbound writer against a compare-and-swap fake of the server's
 *      sync-write (the only external boundary): debounce, create, If-Match,
 *      412 (equal / crdt / external), 429 Retry-After, pacing, capability gate,
 *      text not yet synced with the relay, reconcile;
 *   3. the inbound downloader leaves crdt items to the CRDT and adopts the
 *      base when the vault already holds the server's text.
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { TFile } from "obsidian";

const mockGenerateHash = jest.fn<(data: ArrayBuffer) => Promise<string>>();
jest.mock("src/contentDigest", () => ({
	sha256Hex: mockGenerateHash,
}));
jest.mock("src/logging", () => ({
	namedLogger: () => () => undefined,
}));

import {
	DELETE_MAX_ATTEMPTS,
	MIN_WRITE_INTERVAL_MS,
	NOT_SYNCED_RETRY_MS,
	OUTBOUND_DEBOUNCE_MS,
	OutboundSyncWriter,
	TRANSIENT_RETRY_MS,
	decideOutboundDelete,
	decideOutboundWrite,
	type OutboundDecision,
	type OutboundDeleteDecision,
	type OutboundTarget,
	type ServerSyncItem,
	type SyncWritePrecondition,
} from "src/OutboundSyncWriter";
import { InboundFileDownloader } from "src/InboundFileDownloader";
import { isLocalRemoval } from "src/localRemoval";
import type { ShareRegistry } from "src/VaultShare";
import { RelayHttpError } from "src/relayRequestErrors";
import type { Vault } from "obsidian";

const flushPromises = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ─── 1. decision table ──────────────────────────────────────────────────────

describe("decideOutboundWrite: local / base / server / origin", () => {
	const L = "sha-local";
	const B = "sha-base";
	const S = "sha-server";
	const cases: Array<[string, string | undefined, ServerSyncItem | undefined, OutboundDecision]> = [
		["no server item -> create", undefined, undefined, { kind: "create" }],
		["no server item, stale base -> create", B, undefined, { kind: "create" }],
		["server == local (crdt) -> in sync", undefined, { path: "a.md", sha256: L, origin: "crdt" }, { kind: "in-sync" }],
		["server == local (external) -> in sync", B, { path: "a.md", sha256: L, origin: "external" }, { kind: "in-sync" }],
		["crdt mirror moved -> write over it", B, { path: "a.md", sha256: S, origin: "crdt" }, { kind: "write", ifMatch: S }],
		["crdt mirror, no base -> write over it", undefined, { path: "a.md", sha256: S, origin: "crdt" }, { kind: "write", ifMatch: S }],
		["external == base we pulled -> write", S, { path: "a.md", sha256: S, origin: "external" }, { kind: "write", ifMatch: S }],
		["external not pulled -> wait", B, { path: "a.md", sha256: S, origin: "external" }, { kind: "await-inbound" }],
		["external, no base -> wait", undefined, { path: "a.md", sha256: S, origin: "external" }, { kind: "await-inbound" }],
		["legacy item (no origin) == base -> write", S, { path: "a.md", sha256: S }, { kind: "write", ifMatch: S }],
		["legacy item (no origin) not pulled -> wait", B, { path: "a.md", sha256: S }, { kind: "await-inbound" }],
	];
	test.each(cases)("%s", (_name, base, server, expected) => {
		expect(decideOutboundWrite(L, base, server)).toEqual(expected);
	});
});

// ─── fakes ───────────────────────────────────────────────────────────────────

class FakeClock {
	private t = 1_000_000;
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
	/** Move time forward, firing due timers in order and letting promises settle. */
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

const sha = (text: string): string => `sha(${text})`;

interface StoredItem {
	sha256: string;
	origin: "crdt" | "external";
	content: string;
}

/** Compare-and-swap fake of PUT /sync-write + GET /files-index for one share. */
class FakeServer {
	items = new Map<string, StoredItem>();
	writes: Array<{ path: string; content: string; precondition: SyncWritePrecondition; at: number }> = [];
	failNext: RelayHttpError | null = null;
	beforeWrite: (() => void) | null = null;
	indexReads = 0;
	constructor(private clock: FakeClock) {}

	put(path: string, content: string, origin: "crdt" | "external"): void {
		this.items.set(path, { sha256: sha(content), origin, content });
	}

	index(): ServerSyncItem[] {
		this.indexReads++;
		return Array.from(this.items.entries()).map(([path, item]) => ({
			path,
			sha256: item.sha256,
			origin: item.origin,
		}));
	}

	write(path: string, content: string, precondition: SyncWritePrecondition): { sha256: string } {
		const hook = this.beforeWrite;
		this.beforeWrite = null;
		hook?.();
		if (this.failNext) {
			const err = this.failNext;
			this.failNext = null;
			throw err;
		}
		const current = this.items.get(path);
		if ("create" in precondition ? current !== undefined : current?.sha256 !== precondition.ifMatchSha256) {
			throw new RelayHttpError(412, "Failed to write file content: 412");
		}
		this.writes.push({ path, content, precondition, at: this.clock.now() });
		this.put(path, content, "crdt");
		return { sha256: sha(content) };
	}

	deletes: Array<{ path: string; ifMatch: string; at: number }> = [];

	delete(path: string, ifMatch: string): void {
		const hook = this.beforeWrite;
		this.beforeWrite = null;
		hook?.();
		if (this.failNext) {
			const err = this.failNext;
			this.failNext = null;
			throw err;
		}
		const current = this.items.get(path);
		if (!current) throw new RelayHttpError(404, "Failed to delete file: 404");
		if (current.sha256 !== ifMatch) throw new RelayHttpError(412, "Failed to delete file: 412");
		this.deletes.push({ path, ifMatch, at: this.clock.now() });
		this.items.delete(path);
	}
}

const SHARE = "share-1";
const SERVER = "server-1";
const FOLDER = "Shared";

function setup(opts: { capable?: boolean; deleteCapable?: boolean } = {}) {
	const clock = new FakeClock();
	const server = new FakeServer(clock);
	const disk = new Map<string, string>(); // vault path -> synced text (absent = not synced yet)
	const baseStore = new Map<string, Record<string, string>>();
	/** The next N files-index / server-info reads fail like a dropped connection. */
	const faults = { index: 0, info: 0 };
	const offline = (): Error => new Error("net::ERR_INTERNET_DISCONNECTED");
	const writer = new OutboundSyncWriter({
		clock,
		baseStore,
		resolveTarget: (vaultPath): OutboundTarget | null =>
			vaultPath.startsWith(`${FOLDER}/`)
				? { shareId: SHARE, serverId: SERVER, relativePath: vaultPath.slice(FOLDER.length + 1) }
				: null,
		readSyncedText: async (vaultPath) => disk.get(vaultPath) ?? null,
		supportsSyncOrigin: async () => opts.capable ?? true,
		getFilesIndex: async () => {
			if (faults.index > 0) {
				faults.index--;
				throw offline();
			}
			return server.index();
		},
		syncWrite: async (target, content, precondition) => server.write(target.relativePath, content, precondition),
		sha256: async (text) => sha(text),
		supportsSyncDelete: async () => {
			if (faults.info > 0) {
				faults.info--;
				throw offline();
			}
			return opts.deleteCapable ?? true;
		},
		syncDelete: async (target, ifMatch) => server.delete(target.relativePath, ifMatch),
		existsInVault: (vaultPath) => disk.has(vaultPath),
	});
	const base = (path: string): string | undefined => baseStore.get(SHARE)?.[path];
	return { clock, server, disk, baseStore, writer, base, faults };
}

// ─── 2. outbound writer ─────────────────────────────────────────────────────

describe("OutboundSyncWriter", () => {
	test("an edit reaches the sync protocol after the debounce, as a crdt mirror", async () => {
		const { clock, server, disk, writer, base } = setup();
		server.put("note.md", "v1", "crdt");
		disk.set(`${FOLDER}/note.md`, "v1 + line from Obsidian");

		writer.notifyLocalChange(`${FOLDER}/note.md`);
		await clock.advance(OUTBOUND_DEBOUNCE_MS - 1);
		expect(server.writes).toHaveLength(0);
		await clock.advance(1);

		expect(server.items.get("note.md")).toEqual({
			sha256: sha("v1 + line from Obsidian"),
			origin: "crdt",
			content: "v1 + line from Obsidian",
		});
		expect(server.writes[0].precondition).toEqual({ ifMatchSha256: sha("v1") });
		expect(base("note.md")).toBe(sha("v1 + line from Obsidian"));
	});

	test("a new note is created with If-None-Match: *", async () => {
		const { clock, server, disk, writer } = setup();
		disk.set(`${FOLDER}/new.md`, "# New");

		writer.notifyLocalChange(`${FOLDER}/new.md`);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);

		expect(server.writes).toEqual([
			expect.objectContaining({ path: "new.md", content: "# New", precondition: { create: true } }),
		]);
	});

	test("rapid edits of one path write once, with the latest content", async () => {
		const { clock, server, disk, writer } = setup();
		for (const text of ["a", "ab", "abc"]) {
			disk.set(`${FOLDER}/n.md`, text);
			writer.notifyLocalChange(`${FOLDER}/n.md`);
			await clock.advance(1_000);
		}
		await clock.advance(OUTBOUND_DEBOUNCE_MS);

		expect(server.writes.map((w) => w.content)).toEqual(["abc"]);
	});

	test("ignores paths outside shares and non-.md/.canvas files; canvas is written", async () => {
		const { clock, server, disk, writer } = setup();
		disk.set("Private/x.md", "x");
		disk.set(`${FOLDER}/img.png`, "png");
		disk.set(`${FOLDER}/board.canvas`, "{}");

		writer.notifyLocalChange("Private/x.md");
		writer.notifyLocalChange(`${FOLDER}/img.png`);
		writer.notifyLocalChange(`${FOLDER}/board.canvas`);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);

		expect(server.writes.map((w) => w.path)).toEqual(["board.canvas"]);
	});

	test("waits until the text is synced with the relay before pushing", async () => {
		const { clock, server, disk, writer } = setup();
		writer.notifyLocalChange(`${FOLDER}/n.md`);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);
		expect(server.writes).toHaveLength(0);

		disk.set(`${FOLDER}/n.md`, "settled");
		await clock.advance(NOT_SYNCED_RETRY_MS);

		expect(server.writes.map((w) => w.content)).toEqual(["settled"]);
	});

	test("already in sync: no write, base recorded", async () => {
		const { clock, server, disk, writer, base } = setup();
		server.put("n.md", "same", "external");
		disk.set(`${FOLDER}/n.md`, "same");

		writer.notifyLocalChange(`${FOLDER}/n.md`);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);

		expect(server.writes).toHaveLength(0);
		expect(base("n.md")).toBe(sha("same"));
	});

	test("never overwrites an external version the client has not pulled; writes after the downloader adopts it", async () => {
		const { clock, server, disk, baseStore, writer } = setup();
		server.put("n.md", "written by an agent", "external");
		baseStore.set(SHARE, { "n.md": sha("older") });
		disk.set(`${FOLDER}/n.md`, "local edit");

		writer.notifyLocalChange(`${FOLDER}/n.md`);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);

		expect(server.writes).toHaveLength(0);
		expect(server.items.get("n.md")?.content).toBe("written by an agent");
		expect(writer.pathsAwaitingInbound()).toEqual([`${FOLDER}/n.md`]);

		// The downloader pulls it (or the user keeps local): the base is now the server's.
		baseStore.set(SHARE, { "n.md": sha("written by an agent") });
		writer.onInboundPass(SHARE);
		await clock.advance(MIN_WRITE_INTERVAL_MS);

		expect(server.writes).toEqual([
			expect.objectContaining({ content: "local edit", precondition: { ifMatchSha256: sha("written by an agent") } }),
		]);
		expect(writer.pathsAwaitingInbound()).toEqual([]);
	});

	test("412 because another client mirrored first (crdt): one retry over it", async () => {
		const { clock, server, disk, writer } = setup();
		server.put("n.md", "v1", "crdt");
		disk.set(`${FOLDER}/n.md`, "v1 + mine");
		server.beforeWrite = () => server.put("n.md", "v1 + theirs", "crdt");

		writer.notifyLocalChange(`${FOLDER}/n.md`);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);
		// The retry is paced like any write.
		await clock.advance(MIN_WRITE_INTERVAL_MS);

		expect(server.writes).toEqual([
			expect.objectContaining({ content: "v1 + mine", precondition: { ifMatchSha256: sha("v1 + theirs") } }),
		]);
	});

	test("412 because an agent wrote meanwhile (external): the agent's text is kept, the path waits", async () => {
		const { clock, server, disk, writer } = setup();
		server.put("n.md", "v1", "crdt");
		disk.set(`${FOLDER}/n.md`, "v1 + mine");
		server.beforeWrite = () => server.put("n.md", "from an agent", "external");

		writer.notifyLocalChange(`${FOLDER}/n.md`);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);

		expect(server.writes).toHaveLength(0);
		expect(server.items.get("n.md")?.content).toBe("from an agent");
		expect(writer.pathsAwaitingInbound()).toEqual([`${FOLDER}/n.md`]);
	});

	test("412 and the server already holds the local text: only the base moves", async () => {
		const { clock, server, disk, writer, base } = setup();
		server.put("n.md", "v1", "crdt");
		disk.set(`${FOLDER}/n.md`, "v2");
		server.beforeWrite = () => server.put("n.md", "v2", "crdt");

		writer.notifyLocalChange(`${FOLDER}/n.md`);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);

		expect(server.writes).toHaveLength(0);
		expect(base("n.md")).toBe(sha("v2"));
	});

	test("a second 412 in a row gives up instead of looping", async () => {
		const { clock, server, disk, writer } = setup();
		server.put("n.md", "v1", "crdt");
		disk.set(`${FOLDER}/n.md`, "mine");
		server.beforeWrite = () => {
			server.put("n.md", "theirs-1", "crdt");
			server.beforeWrite = () => server.put("n.md", "theirs-2", "crdt");
		};

		writer.notifyLocalChange(`${FOLDER}/n.md`);
		await clock.advance(60_000);

		expect(server.writes).toHaveLength(0);
		expect(server.items.get("n.md")?.content).toBe("theirs-2");
	});

	test("429 honours Retry-After", async () => {
		const { clock, server, disk, writer } = setup();
		disk.set(`${FOLDER}/n.md`, "text");
		server.failNext = new RelayHttpError(429, "Too Many Requests", 20_000);

		writer.notifyLocalChange(`${FOLDER}/n.md`);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);
		expect(server.writes).toHaveLength(0);
		await clock.advance(19_000);
		expect(server.writes).toHaveLength(0);
		await clock.advance(1_000);

		expect(server.writes.map((w) => w.content)).toEqual(["text"]);
	});

	test("writes are paced below the server's 60/minute limit", async () => {
		const { clock, server, disk, writer } = setup();
		for (const name of ["a", "b", "c"]) disk.set(`${FOLDER}/${name}.md`, name);

		writer.reconcile(["a", "b", "c"].map((n) => `${FOLDER}/${n}.md`));
		await clock.advance(10_000);

		const times = server.writes.map((w) => w.at);
		expect(times).toHaveLength(3);
		expect(times[1] - times[0]).toBeGreaterThanOrEqual(MIN_WRITE_INTERVAL_MS);
		expect(times[2] - times[1]).toBeGreaterThanOrEqual(MIN_WRITE_INTERVAL_MS);
	});

	test("stays off when the server does not advertise sync_write_origin", async () => {
		const { clock, server, disk, writer } = setup({ capable: false });
		disk.set(`${FOLDER}/n.md`, "text");

		writer.notifyLocalChange(`${FOLDER}/n.md`);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);

		expect(server.writes).toHaveLength(0);
		expect(server.indexReads).toBe(0);
	});

	test("reconcile pushes only diverged files, reads the index once, and skips unsynced text", async () => {
		const { clock, server, disk, writer } = setup();
		server.put("same.md", "same", "crdt");
		server.put("old.md", "old", "crdt");
		disk.set(`${FOLDER}/same.md`, "same");
		disk.set(`${FOLDER}/old.md`, "edited by a client that does not mirror");
		disk.set(`${FOLDER}/fresh.md`, "never on the server");
		// `${FOLDER}/unsynced.md` has no synced text yet

		writer.reconcile(["same", "old", "fresh", "unsynced"].map((n) => `${FOLDER}/${n}.md`));
		await clock.advance(10_000);
		await clock.advance(NOT_SYNCED_RETRY_MS * 3);

		expect(server.writes.map((w) => w.path).sort()).toEqual(["fresh.md", "old.md"]);
		expect(server.indexReads).toBe(1);
	});

	test("destroy cancels pending writes", async () => {
		const { clock, server, disk, writer } = setup();
		disk.set(`${FOLDER}/n.md`, "text");

		writer.notifyLocalChange(`${FOLDER}/n.md`);
		writer.destroy();
		await clock.advance(OUTBOUND_DEBOUNCE_MS * 2);

		expect(server.writes).toHaveLength(0);
	});
});

// ─── 3. inbound downloader and origin ───────────────────────────────────────

function makeDownloaderFakes() {
	const adapter = {
		mkdir: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
		writeBinary: jest.fn<(path: string, data: ArrayBuffer) => Promise<void>>().mockResolvedValue(undefined),
	};
	const getAbstractFileByPath = jest.fn<(path: string) => TFile | null>().mockReturnValue(null);
	const readBinary = jest.fn<() => Promise<ArrayBuffer>>().mockResolvedValue(new ArrayBuffer(4));
	const clientManager = {
		getShare: jest.fn<() => Promise<{ id: string; path: string }>>(),
		getFilesIndex: jest.fn<() => Promise<Array<Record<string, unknown>>>>().mockResolvedValue([]),
		downloadFile: jest.fn<() => Promise<ArrayBuffer>>().mockResolvedValue(new ArrayBuffer(8)),
	};
	return { adapter, getAbstractFileByPath, readBinary, clientManager };
}

/** The jest mock's TFile takes a path; the real Obsidian type has a no-arg constructor. */
const mockTFile = (path: string): TFile => new (TFile as unknown as new (path: string) => TFile)(path);

describe("InboundFileDownloader with origin", () => {
	const SHARE_PATH = "shared/docs";
	let fakes: ReturnType<typeof makeDownloaderFakes>;
	let vault: ReturnType<typeof makeDownloaderFakes>["adapter"] extends unknown
		? { adapter: ReturnType<typeof makeDownloaderFakes>["adapter"]; getAbstractFileByPath: ReturnType<typeof makeDownloaderFakes>["getAbstractFileByPath"] }
		: never;
	let clientManager: ReturnType<typeof makeDownloaderFakes>["clientManager"];
	let manifest: Map<string, Record<string, string>>;
	let downloader: InboundFileDownloader;

	beforeEach(() => {
		jest.clearAllMocks();
		fakes = makeDownloaderFakes();
		vault = { adapter: fakes.adapter, getAbstractFileByPath: fakes.getAbstractFileByPath };
		clientManager = fakes.clientManager;
		clientManager.getShare.mockResolvedValue({ id: "s", path: SHARE_PATH });
		manifest = new Map();
		downloader = new InboundFileDownloader(
			{ ...vault, readBinary: fakes.readBinary } as unknown as Vault,
			clientManager as never,
			{ isOutboundSyncing: false } as never,
			manifest,
		);
	});

	const index = (origin: string | undefined, sha256 = "sha-server") => [
		{ path: "note.md", sha256, size: 8, updated_at: "2026-11-15T00:00:00Z", type: "sync-artifact", origin },
	];

	test("a crdt mirror is not written to disk (the relay delivers it)", async () => {
		clientManager.getFilesIndex.mockResolvedValue(index("crdt"));
		vault.getAbstractFileByPath.mockReturnValue(mockTFile(`${SHARE_PATH}/note.md`));
		mockGenerateHash.mockResolvedValue("sha-local-older");

		await downloader.downloadShare("s", "srv");

		expect(clientManager.downloadFile).not.toHaveBeenCalled();
		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
		expect(downloader.getConflicts()).toEqual([]);
	});

	test("a crdt mirror the vault does not have yet is not created from the sync protocol", async () => {
		clientManager.getFilesIndex.mockResolvedValue(index("crdt"));

		await downloader.downloadShare("s", "srv");

		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
	});

	test("a crdt mirror equal to the local file becomes the base", async () => {
		clientManager.getFilesIndex.mockResolvedValue(index("crdt"));
		vault.getAbstractFileByPath.mockReturnValue(mockTFile(`${SHARE_PATH}/note.md`));
		mockGenerateHash.mockResolvedValue("sha-server");

		await downloader.downloadShare("s", "srv");

		expect(manifest.get("s")).toEqual({ "note.md": "sha-server" });
	});

	test("an external version is still downloaded (agent -> Obsidian unchanged)", async () => {
		clientManager.getFilesIndex.mockResolvedValue(index("external"));

		await downloader.downloadShare("s", "srv");

		expect(vault.adapter.writeBinary).toHaveBeenCalledWith(`${SHARE_PATH}/note.md`, expect.any(ArrayBuffer));
		expect(manifest.get("s")).toEqual({ "note.md": "sha-server" });
	});

	test("an external version equal to the local file only moves the base, no conflict", async () => {
		manifest.set("s", { "note.md": "sha-old-base" });
		clientManager.getFilesIndex.mockResolvedValue(index("external"));
		vault.getAbstractFileByPath.mockReturnValue(mockTFile(`${SHARE_PATH}/note.md`));
		mockGenerateHash.mockResolvedValue("sha-server");

		await downloader.downloadShare("s", "srv");

		expect(vault.adapter.writeBinary).not.toHaveBeenCalled();
		expect(downloader.getConflicts()).toEqual([]);
		expect(manifest.get("s")).toEqual({ "note.md": "sha-server" });
	});

	test("a base the outbound writer records during a pass is not clobbered", async () => {
		clientManager.getFilesIndex.mockImplementation(async () => {
			manifest.set("s", { "other.md": "sha-written-by-writer" });
			return index("external");
		});

		await downloader.downloadShare("s", "srv");

		expect(manifest.get("s")).toEqual({ "other.md": "sha-written-by-writer", "note.md": "sha-server" });
	});

	test("a same-path base the writer records while the pass downloads it wins", async () => {
		clientManager.getFilesIndex.mockResolvedValue(index("external"));
		vault.adapter.writeBinary.mockImplementation(async () => {
			manifest.set("s", { ...(manifest.get("s") ?? {}), "note.md": "sha-writer-newer" });
		});

		await downloader.downloadShare("s", "srv");

		expect(vault.adapter.writeBinary).toHaveBeenCalled();
		expect(manifest.get("s")).toEqual({ "note.md": "sha-writer-newer" });
	});

	test("notifies the pass listener after a pass and after keep-local", async () => {
		const listener = jest.fn<(shareId: string) => void>();
		downloader.setPassListener(listener);
		clientManager.getFilesIndex.mockResolvedValue(index("external"));
		vault.getAbstractFileByPath.mockReturnValue(mockTFile(`${SHARE_PATH}/note.md`));
		mockGenerateHash.mockResolvedValue("sha-local-edit");

		await downloader.downloadShare("s", "srv");
		expect(listener).toHaveBeenCalledWith("s");
		expect(downloader.getConflicts()).toHaveLength(1);

		listener.mockClear();
		downloader.resolveKeepLocal("s", "note.md");
		expect(listener).toHaveBeenCalledWith("s");
	});
});

// ─── 4. deletes ─────────────────────────────────────────────────

describe("decideOutboundDelete: base / server / origin", () => {
	const B = "sha-base";
	const S = "sha-server";
	const cases: Array<[string, string | undefined, ServerSyncItem | undefined, OutboundDeleteDecision]> = [
		["no server item -> gone", B, undefined, { kind: "gone" }],
		["crdt mirror -> delete it", undefined, { path: "a.md", sha256: S, origin: "crdt" }, { kind: "delete", ifMatch: S }],
		["external == base we pulled -> delete", S, { path: "a.md", sha256: S, origin: "external" }, { kind: "delete", ifMatch: S }],
		["external not pulled -> keep", B, { path: "a.md", sha256: S, origin: "external" }, { kind: "keep-external" }],
		["external, no base -> keep", undefined, { path: "a.md", sha256: S, origin: "external" }, { kind: "keep-external" }],
		["legacy item (no origin) == base -> delete", S, { path: "a.md", sha256: S }, { kind: "delete", ifMatch: S }],
	];
	test.each(cases)("%s", (_name, base, server, expected) => {
		expect(decideOutboundDelete(base, server)).toEqual(expected);
	});
});

describe("OutboundSyncWriter deletes", () => {
	test("a deleted note leaves the sync protocol after the debounce, If-Match the crdt mirror", async () => {
		const { clock, server, writer, baseStore, base } = setup();
		server.put("_acceptance/roundtrip.md", "roundtrip", "crdt");
		baseStore.set(SHARE, { "_acceptance/roundtrip.md": sha("roundtrip") });

		writer.notifyLocalDelete(`${FOLDER}/_acceptance/roundtrip.md`, false);
		await clock.advance(OUTBOUND_DEBOUNCE_MS - 1);
		expect(server.deletes).toHaveLength(0);
		await clock.advance(1);

		expect(server.deletes).toEqual([
			expect.objectContaining({ path: "_acceptance/roundtrip.md", ifMatch: sha("roundtrip") }),
		]);
		expect(server.items.has("_acceptance/roundtrip.md")).toBe(false);
		expect(base("_acceptance/roundtrip.md")).toBeUndefined();
	});

	test("a folder delete removes every entry under it and nothing beside it", async () => {
		const { clock, server, writer } = setup();
		server.put("dir/a.md", "a", "crdt");
		server.put("dir/sub/b.md", "b", "crdt");
		server.put("dir2/c.md", "c", "crdt");
		server.put("dir.md", "d", "crdt");

		writer.notifyLocalDelete(`${FOLDER}/dir`, true);
		await clock.advance(OUTBOUND_DEBOUNCE_MS + MIN_WRITE_INTERVAL_MS * 3);

		expect(server.deletes.map((d) => d.path).sort()).toEqual(["dir/a.md", "dir/sub/b.md"]);
		expect(Array.from(server.items.keys()).sort()).toEqual(["dir.md", "dir2/c.md"]);
	});

	test("an external version the client has not pulled is not deleted", async () => {
		const { clock, server, writer, baseStore } = setup();
		server.put("n.md", "written by an agent after our pull", "external");
		baseStore.set(SHARE, { "n.md": sha("what we pulled") });

		writer.notifyLocalDelete(`${FOLDER}/n.md`, false);
		await clock.advance(OUTBOUND_DEBOUNCE_MS * 2);

		expect(server.deletes).toHaveLength(0);
		expect(server.items.has("n.md")).toBe(true);
	});

	test("an external version equal to the client's base is deleted", async () => {
		const { clock, server, writer, baseStore } = setup();
		server.put("n.md", "pulled", "external");
		baseStore.set(SHARE, { "n.md": sha("pulled") });

		writer.notifyLocalDelete(`${FOLDER}/n.md`, false);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);

		expect(server.deletes.map((d) => d.ifMatch)).toEqual([sha("pulled")]);
	});

	test("412 because an agent wrote meanwhile: the newer external version is kept", async () => {
		const { clock, server, writer, baseStore } = setup();
		server.put("n.md", "v1", "crdt");
		baseStore.set(SHARE, { "n.md": sha("v1") });
		server.beforeWrite = () => server.put("n.md", "v2 from an agent", "external");

		writer.notifyLocalDelete(`${FOLDER}/n.md`, false);
		await clock.advance(OUTBOUND_DEBOUNCE_MS * 2);

		expect(server.deletes).toHaveLength(0);
		expect(server.items.get("n.md")?.content).toBe("v2 from an agent");
	});

	test("412 because another client mirrored first (crdt): one re-read, then deleted", async () => {
		const { clock, server, writer } = setup();
		server.put("n.md", "v1", "crdt");
		server.beforeWrite = () => server.put("n.md", "v1 + peer line", "crdt");

		writer.notifyLocalDelete(`${FOLDER}/n.md`, false);
		await clock.advance(OUTBOUND_DEBOUNCE_MS * 2);

		expect(server.deletes.map((d) => d.ifMatch)).toEqual([sha("v1 + peer line")]);
		expect(server.items.has("n.md")).toBe(false);
	});

	test("404: already gone, the base is cleared and nothing retries", async () => {
		const { clock, server, writer, baseStore, base } = setup();
		server.put("n.md", "v1", "crdt");
		baseStore.set(SHARE, { "n.md": sha("v1") });
		server.beforeWrite = () => server.items.delete("n.md");

		writer.notifyLocalDelete(`${FOLDER}/n.md`, false);
		await clock.advance(OUTBOUND_DEBOUNCE_MS * 4);

		expect(server.deletes).toHaveLength(0);
		expect(base("n.md")).toBeUndefined();
	});

	test("429 honours Retry-After", async () => {
		const { clock, server, writer } = setup();
		server.put("n.md", "v1", "crdt");
		server.failNext = new RelayHttpError(429, "slow down", 20_000);

		writer.notifyLocalDelete(`${FOLDER}/n.md`, false);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);
		expect(server.deletes).toHaveLength(0);
		await clock.advance(20_000);

		expect(server.deletes.map((d) => d.path)).toEqual(["n.md"]);
	});

	test("a delete cancels a pending write of the same path", async () => {
		const { clock, server, disk, writer } = setup();
		server.put("n.md", "v1", "crdt");
		disk.set(`${FOLDER}/n.md`, "v1 edited");
		writer.notifyLocalChange(`${FOLDER}/n.md`);
		disk.delete(`${FOLDER}/n.md`);
		writer.notifyLocalDelete(`${FOLDER}/n.md`, false);
		await clock.advance(OUTBOUND_DEBOUNCE_MS * 2);

		expect(server.writes).toHaveLength(0);
		expect(server.deletes.map((d) => d.path)).toEqual(["n.md"]);
	});

	test("re-created before the flush: the write wins, nothing is deleted", async () => {
		const { clock, server, disk, writer } = setup();
		server.put("n.md", "v1", "crdt");
		writer.notifyLocalDelete(`${FOLDER}/n.md`, false);
		disk.set(`${FOLDER}/n.md`, "back again");
		writer.notifyLocalChange(`${FOLDER}/n.md`);
		await clock.advance(OUTBOUND_DEBOUNCE_MS * 2);

		expect(server.deletes).toHaveLength(0);
		expect(server.items.get("n.md")?.content).toBe("back again");
	});

	test("rename: old path deleted, new path written", async () => {
		const { clock, server, disk, writer } = setup();
		server.put("old.md", "text", "crdt");
		disk.set(`${FOLDER}/new.md`, "text");

		writer.notifyLocalDelete(`${FOLDER}/old.md`, false);
		writer.notifyLocalChange(`${FOLDER}/new.md`);
		await clock.advance(OUTBOUND_DEBOUNCE_MS + MIN_WRITE_INTERVAL_MS * 2);

		expect(Array.from(server.items.keys())).toEqual(["new.md"]);
	});

	test("stays off when the server does not advertise sync_delete", async () => {
		const { clock, server, writer } = setup({ deleteCapable: false });
		server.put("n.md", "v1", "crdt");

		writer.notifyLocalDelete(`${FOLDER}/n.md`, false);
		await clock.advance(OUTBOUND_DEBOUNCE_MS * 2);

		expect(server.deletes).toHaveLength(0);
	});

	test("deletes are paced like writes", async () => {
		const { clock, server, writer } = setup();
		for (const n of ["a", "b", "c"]) server.put(`dir/${n}.md`, n, "crdt");

		writer.notifyLocalDelete(`${FOLDER}/dir`, true);
		await clock.advance(OUTBOUND_DEBOUNCE_MS + MIN_WRITE_INTERVAL_MS * 3);

		const at = server.deletes.map((d) => d.at);
		expect(at).toHaveLength(3);
		expect(at[1] - at[0]).toBeGreaterThanOrEqual(MIN_WRITE_INTERVAL_MS);
		expect(at[2] - at[1]).toBeGreaterThanOrEqual(MIN_WRITE_INTERVAL_MS);
	});

	test("reconcile deletes entries gone from disk and CRDT, under the same rules", async () => {
		const { clock, server, writer, baseStore } = setup();
		server.put("deleted-offline.md", "x", "crdt");
		server.put("still-in-crdt.md", "y", "crdt");
		server.put("pulled-then-deleted.md", "z", "external");
		server.put("external-not-pulled.md", "w", "external");
		baseStore.set(SHARE, { "pulled-then-deleted.md": sha("z") });
		const live = new Set(["still-in-crdt.md"]);

		await writer.reconcileDeletes(
			{ shareId: SHARE, serverId: SERVER },
			(rel) => `${FOLDER}/${rel}`,
			(rel) => live.has(rel),
		);
		await clock.advance(MIN_WRITE_INTERVAL_MS * 4);

		expect(server.deletes.map((d) => d.path).sort()).toEqual([
			"deleted-offline.md",
			"pulled-then-deleted.md",
		]);
		expect(Array.from(server.items.keys()).sort()).toEqual(["external-not-pulled.md", "still-in-crdt.md"]);
	});

	test("reconcile does not delete an entry that came back to the CRDT before the flush", async () => {
		const { clock, server, writer } = setup();
		server.put("a.md", "x", "crdt");
		server.put("b.md", "y", "crdt");
		const live = new Set<string>();

		await writer.reconcileDeletes(
			{ shareId: SHARE, serverId: SERVER },
			(rel) => `${FOLDER}/${rel}`,
			(rel) => live.has(rel),
		);
		live.add("b.md");
		await clock.advance(MIN_WRITE_INTERVAL_MS * 4);

		expect(server.deletes.map((d) => d.path)).toEqual(["a.md"]);
	});
	test("files-index unreadable at flush: the delete is kept and retried", async () => {
		const { clock, server, writer, faults } = setup();
		server.put("n.md", "v1", "crdt");
		faults.index = 1;

		writer.notifyLocalDelete(`${FOLDER}/n.md`, false);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);
		expect(server.deletes).toHaveLength(0);
		await clock.advance(TRANSIENT_RETRY_MS);

		expect(server.deletes.map((d) => d.path)).toEqual(["n.md"]);
		expect(server.items.has("n.md")).toBe(false);
	});

	test("server-info unreadable at flush: not taken for 'unsupported', the delete is retried", async () => {
		const { clock, server, writer, faults } = setup();
		server.put("dir/a.md", "a", "crdt");
		server.put("dir/b.md", "b", "crdt");
		faults.info = 1;

		writer.notifyLocalDelete(`${FOLDER}/dir`, true);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);
		expect(server.deletes).toHaveLength(0);
		await clock.advance(TRANSIENT_RETRY_MS + MIN_WRITE_INTERVAL_MS * 2);

		expect(server.deletes.map((d) => d.path).sort()).toEqual(["dir/a.md", "dir/b.md"]);
	});

	test("files-index unreadable on the 412 re-read: the delete is retried", async () => {
		const { clock, server, writer, faults } = setup();
		server.put("n.md", "v1", "crdt");
		server.beforeWrite = () => {
			server.put("n.md", "v1 + peer line", "crdt");
			faults.index = 1;
		};

		writer.notifyLocalDelete(`${FOLDER}/n.md`, false);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);
		expect(server.deletes).toHaveLength(0);
		await clock.advance(TRANSIENT_RETRY_MS);

		expect(server.deletes.map((d) => d.ifMatch)).toEqual([sha("v1 + peer line")]);
	});

	test("a delete that keeps failing gives up after DELETE_MAX_ATTEMPTS", async () => {
		const { clock, server, writer, faults } = setup();
		server.put("n.md", "v1", "crdt");
		faults.index = 1_000;

		writer.notifyLocalDelete(`${FOLDER}/n.md`, false);
		await clock.advance(OUTBOUND_DEBOUNCE_MS + TRANSIENT_RETRY_MS * (DELETE_MAX_ATTEMPTS + 5));

		expect(1_000 - faults.index).toBe(DELETE_MAX_ATTEMPTS);
		expect(server.deletes).toHaveLength(0);
	});

	test("reconcile: an entry back in the CRDT during the pacing wait is not deleted", async () => {
		const { clock, server, writer } = setup();
		server.put("a.md", "x", "crdt");
		server.put("b.md", "y", "crdt");
		const live = new Set<string>();
		// b.md comes back while its DELETE waits for the write slot after a.md's.
		server.beforeWrite = () => {
			clock.scheduleTimeout(() => live.add("b.md"), MIN_WRITE_INTERVAL_MS / 2);
		};

		await writer.reconcileDeletes(
			{ shareId: SHARE, serverId: SERVER },
			(rel) => `${FOLDER}/${rel}`,
			(rel) => live.has(rel),
		);
		await clock.advance(MIN_WRITE_INTERVAL_MS * 4);

		expect(server.deletes.map((d) => d.path)).toEqual(["a.md"]);
		expect(server.items.has("b.md")).toBe(true);
	});

	test("reconcile: the liveness check survives a transient retry", async () => {
		const { clock, server, writer } = setup();
		server.put("a.md", "x", "crdt");
		server.failNext = new RelayHttpError(503, "unavailable");
		const live = new Set<string>();

		await writer.reconcileDeletes(
			{ shareId: SHARE, serverId: SERVER },
			(rel) => `${FOLDER}/${rel}`,
			(rel) => live.has(rel),
		);
		await clock.advance(MIN_WRITE_INTERVAL_MS);
		expect(server.deletes).toHaveLength(0);
		live.add("a.md");
		await clock.advance(TRANSIENT_RETRY_MS * 2);

		expect(server.deletes).toHaveLength(0);
		expect(server.items.has("a.md")).toBe(true);
	});

	test("reconcile: a transient retry still deletes an entry that stayed gone", async () => {
		const { clock, server, writer } = setup();
		server.put("a.md", "x", "crdt");
		server.failNext = new RelayHttpError(503, "unavailable");

		await writer.reconcileDeletes(
			{ shareId: SHARE, serverId: SERVER },
			(rel) => `${FOLDER}/${rel}`,
			() => false,
		);
		await clock.advance(MIN_WRITE_INTERVAL_MS + TRANSIENT_RETRY_MS);

		expect(server.deletes.map((d) => d.path)).toEqual(["a.md"]);
	});
	test("reconcile: server-info unreadable on the first scan, the scan retries without a reconnect", async () => {
		const { clock, server, writer, faults } = setup();
		server.put("n.md", "x", "crdt");
		faults.info = 1;

		await writer.reconcileDeletes({ shareId: SHARE, serverId: SERVER }, (rel) => `${FOLDER}/${rel}`, () => false);
		await clock.advance(MIN_WRITE_INTERVAL_MS);
		expect(server.deletes).toHaveLength(0);
		await clock.advance(TRANSIENT_RETRY_MS + MIN_WRITE_INTERVAL_MS);

		expect(server.deletes.map((d) => d.path)).toEqual(["n.md"]);
		expect(server.items.size).toBe(0);
	});

	test("reconcile: files-index unreadable on the first scan, the scan retries without a reconnect", async () => {
		const { clock, server, writer, faults } = setup();
		server.put("n.md", "x", "crdt");
		faults.index = 1;

		await writer.reconcileDeletes({ shareId: SHARE, serverId: SERVER }, (rel) => `${FOLDER}/${rel}`, () => false);
		await clock.advance(MIN_WRITE_INTERVAL_MS);
		expect(server.deletes).toHaveLength(0);
		await clock.advance(TRANSIENT_RETRY_MS + MIN_WRITE_INTERVAL_MS);

		expect(server.deletes.map((d) => d.path)).toEqual(["n.md"]);
	});

	test("reconcile: a retried scan still skips entries that came back meanwhile", async () => {
		const { clock, server, writer, faults } = setup();
		server.put("a.md", "x", "crdt");
		server.put("b.md", "y", "crdt");
		faults.index = 1;
		const live = new Set<string>();

		await writer.reconcileDeletes({ shareId: SHARE, serverId: SERVER }, (rel) => `${FOLDER}/${rel}`, (rel) => live.has(rel));
		live.add("b.md");
		await clock.advance(TRANSIENT_RETRY_MS + MIN_WRITE_INTERVAL_MS * 3);

		expect(server.deletes.map((d) => d.path)).toEqual(["a.md"]);
	});

	test("reconcile: a scan that keeps failing gives up after DELETE_MAX_ATTEMPTS", async () => {
		const { clock, server, writer, faults } = setup();
		server.put("n.md", "x", "crdt");
		faults.index = 1_000;

		await writer.reconcileDeletes({ shareId: SHARE, serverId: SERVER }, (rel) => `${FOLDER}/${rel}`, () => false);
		await clock.advance(TRANSIENT_RETRY_MS * (DELETE_MAX_ATTEMPTS + 5));

		expect(1_000 - faults.index).toBe(DELETE_MAX_ATTEMPTS);
		expect(server.deletes).toHaveLength(0);
	});

	test("reconcile: a new reconnect replaces a pending scan retry instead of doubling it", async () => {
		const { clock, server, writer, faults } = setup();
		server.put("n.md", "x", "crdt");
		faults.index = 1;
		const share = { shareId: SHARE, serverId: SERVER };

		await writer.reconcileDeletes(share, (rel) => `${FOLDER}/${rel}`, () => false);
		const readsBefore = server.indexReads;
		await writer.reconcileDeletes(share, (rel) => `${FOLDER}/${rel}`, () => false);
		await clock.advance(TRANSIENT_RETRY_MS * 3);

		expect(server.indexReads - readsBefore).toBe(1);
		expect(server.deletes.map((d) => d.path)).toEqual(["n.md"]);
	});
});

describe("isLocalRemoval: own delete vs echo", () => {
	const records = new Set(["note.md", "dir", "plain/child.md"]);
	const registry = {
		shareFor: (path: string) =>
			path.startsWith(`${FOLDER}/`)
				? {
						path: FOLDER,
						folderIndex: {
							recordFor: (v: string) => (records.has(v) ? {} : undefined),
							eachRecord: (fn: (meta: object, path: string) => void) => records.forEach((r) => fn({}, r)),
						},
					}
				: null,
	} as unknown as ShareRegistry;

	test("a path still in the folder index is the user's own delete", () => {
		expect(isLocalRemoval(registry, `${FOLDER}/note.md`, () => false)).toBe(true);
		expect(isLocalRemoval(registry, `${FOLDER}/dir`, () => false)).toBe(true);
	});

	test("a folder without its own record counts by its contents", () => {
		expect(isLocalRemoval(registry, `${FOLDER}/plain`, () => false)).toBe(true);
		expect(isLocalRemoval(registry, `${FOLDER}/pla`, () => false)).toBe(false);
	});

	test("a path a peer already removed from the index is an echo", () => {
		expect(isLocalRemoval(registry, `${FOLDER}/gone.md`, () => false)).toBe(false);
	});

	test("an inbound-downloader removal is an echo", () => {
		expect(isLocalRemoval(registry, `${FOLDER}/note.md`, () => true)).toBe(false);
	});

	test("outside every share: nothing to report", () => {
		expect(isLocalRemoval(registry, "Private/note.md", () => false)).toBe(false);
	});
});
