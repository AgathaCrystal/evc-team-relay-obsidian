/**
 * Fresh client without a base.
 *
 * A new device, a reinstall or a new member receives the live note through
 * the CRDT. When the CRDT is ahead of the share's external sync copy (lines
 * written in Obsidian <= 0.1.34 never reached the sync protocol), the
 * downloader used to see "local != server, no base" and raise a conflict
 * without moving the base, while the outbound writer waited for that base
 * (`await-inbound`): no edit reached files-index until the user pressed
 * "Keep local". These tests pin:
 *   1. the line-containment check that decides "the local text already holds
 *      the server version";
 *   2. the downloader adopts such a server version as the base without
 *      writing, and still raises a conflict (now naming the local text's
 *      origin) when lines would be lost;
 *   3. the loop end to end: writer + downloader on one base store, a compare-
 *      and-swap fake of the server (the only external boundary).
 */

import { describe, test, expect, beforeEach, jest } from "@jest/globals";
import { TFile } from "obsidian";
import type { Vault } from "obsidian";

const textOf = (data: ArrayBuffer): string => new TextDecoder().decode(data);
const sha = (text: string): string => `sha(${text})`;

jest.mock("src/contentDigest", () => ({
	sha256Hex: async (data: ArrayBuffer) => `sha(${new TextDecoder().decode(data)})`,
}));
jest.mock("src/logging", () => ({
	namedLogger: () => () => undefined,
}));

import { InboundFileDownloader, containsAllLinesInOrder } from "src/InboundFileDownloader";
import {
	OUTBOUND_DEBOUNCE_MS,
	OutboundSyncWriter,
	type ServerSyncItem,
	type SyncWritePrecondition,
} from "src/OutboundSyncWriter";
import { RelayHttpError } from "src/relayRequestErrors";

const flushPromises = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const mockTFile = (path: string): TFile => new (TFile as unknown as new (path: string) => TFile)(path);

// ─── 1. containment ─────────────────────────────────────────────────────────

describe("containsAllLinesInOrder", () => {
	test.each([
		["added line at the end", "a\nb\nc\n", "a\nb\n", true],
		["added line in the middle", "a\nnew\nb", "a\nb", true],
		["CRLF on one side", "a\r\nb\r\nc", "a\nb", true],
		["blank lines on the server side are ignored", "a\nb", "a\n\n\nb\n", true],
		["identical", "a\nb", "a\nb", true],
		["a server line edited locally", "a\nb edited", "a\nb", false],
		["a server line missing locally", "a\nc", "a\nb\nc", false],
		["order swapped", "b\na", "a\nb", false],
		["scattered characters are not lines", "xSxtxaxtxuxsx: done", "Status: done", false],
	])("%s", (_name, local, server, expected) => {
		expect(containsAllLinesInOrder(local, server)).toBe(expected);
	});
});

// ─── shared fakes ───────────────────────────────────────────────────────────

const SHARE = "share-1";
const SERVER = "server-1";
const FOLDER = "Shared";
const PATH = "roundtrip.md";
const VAULT_PATH = `${FOLDER}/${PATH}`;

// The repro of 2026-11-18: the sync copy has two lines, the CRDT a third one
// written in Obsidian 0.1.33 that never reached the sync protocol.
const EXTERNAL = "# Roundtrip\nLine written by an agent.\n";
const CRDT = "# Roundtrip\nLine written by an agent.\nLine written in Obsidian 15.11.\n";
const EDITED = `${CRDT}Line written in Obsidian 0.1.35.\n`;

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

/** Compare-and-swap fake of files-index / download / sync-write for one share. */
class FakeServer {
	items = new Map<string, { content: string; origin: "crdt" | "external" }>();
	writes: Array<{ path: string; content: string; precondition: SyncWritePrecondition }> = [];
	downloads = 0;
	/** Served once instead of the live index: a files-index read older than the item. */
	staleIndex: ReturnType<FakeServer["index"]> | null = null;

	put(path: string, content: string, origin: "crdt" | "external"): void {
		this.items.set(path, { content, origin });
	}

	index(): Array<ServerSyncItem & { type: string; size: number; updated_at: string }> {
		const stale = this.staleIndex;
		this.staleIndex = null;
		if (stale) return stale;
		return Array.from(this.items.entries()).map(([path, item]) => ({
			path,
			sha256: sha(item.content),
			origin: item.origin,
			type: "sync-artifact",
			size: item.content.length,
			updated_at: "2026-11-18T00:00:00Z",
		}));
	}

	download(path: string): ArrayBuffer {
		this.downloads++;
		const item = this.items.get(path);
		if (!item) throw new RelayHttpError(404, "not found");
		return bytes(item.content);
	}

	write(path: string, content: string, precondition: SyncWritePrecondition): { sha256: string } {
		const current = this.items.get(path);
		const ok =
			"create" in precondition
				? current === undefined
				: current !== undefined && sha(current.content) === precondition.ifMatchSha256;
		if (!ok) throw new RelayHttpError(412, "Failed to write file content: 412");
		this.writes.push({ path, content, precondition });
		this.put(path, content, "crdt");
		return { sha256: sha(content) };
	}
}

function setup() {
	const clock = new FakeClock();
	const server = new FakeServer();
	const disk = new Map<string, string>(); // vault path -> text on disk (= the live CRDT text)
	const baseStore = new Map<string, Record<string, string>>();
	const adapter = {
		mkdir: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
		writeBinary: jest.fn(async (path: string, data: ArrayBuffer) => {
			disk.set(path, textOf(data));
		}),
	};
	const vault = {
		adapter,
		getAbstractFileByPath: (path: string) => (disk.has(path) ? mockTFile(path) : null),
		readBinary: async (file: TFile) => bytes(disk.get(file.path) ?? ""),
		modifyBinary: jest.fn(async (file: TFile, data: ArrayBuffer) => {
			disk.set(file.path, textOf(data));
		}),
	};
	// Deleting a note in a shared folder removes it from the CRDT for every
	// member; recorded here so a test can prove it never happens.
	const trashFile = jest.fn(async (file: TFile) => {
		disk.delete(file.path);
	});
	const clientManager = {
		getShare: async () => ({ id: SHARE, path: FOLDER }),
		getFilesIndex: async () => server.index(),
		downloadFile: async (_srv: string, _share: string, path: string) => server.download(path),
	};
	const downloader = new InboundFileDownloader(
		vault as unknown as Vault,
		clientManager as never,
		{ isOutboundSyncing: false } as never,
		baseStore,
	);
	const writer = new OutboundSyncWriter({
		clock,
		baseStore,
		resolveTarget: (vaultPath) =>
			vaultPath.startsWith(`${FOLDER}/`)
				? { shareId: SHARE, serverId: SERVER, relativePath: vaultPath.slice(FOLDER.length + 1) }
				: null,
		readSyncedText: async (vaultPath) => disk.get(vaultPath) ?? null,
		supportsSyncOrigin: async () => true,
		getFilesIndex: async () => server.index(),
		syncWrite: async (target, content, precondition) => server.write(target.relativePath, content, precondition),
		sha256: async (text) => sha(text),
		supportsSyncDelete: async () => false,
		syncDelete: async () => undefined,
		existsInVault: (vaultPath) => disk.has(vaultPath),
	});
	downloader.setPassListener((shareId) => writer.onInboundPass(shareId));
	const base = (): string | undefined => baseStore.get(SHARE)?.[PATH];
	return { clock, server, disk, baseStore, adapter, vault, downloader, writer, base, trashFile };
}

// ─── 2. downloader ──────────────────────────────────────────────────────────

describe("InboundFileDownloader without a base", () => {
	let env: ReturnType<typeof setup>;
	beforeEach(() => {
		env = setup();
	});

	test("local text holding every server line: the server version becomes the base, nothing is written", async () => {
		env.server.put(PATH, EXTERNAL, "external");
		env.disk.set(VAULT_PATH, CRDT);

		await env.downloader.downloadShare(SHARE, SERVER);

		expect(env.base()).toBe(sha(EXTERNAL));
		expect(env.downloader.getConflicts()).toEqual([]);
		expect(env.adapter.writeBinary).not.toHaveBeenCalled();
		expect(env.disk.get(VAULT_PATH)).toBe(CRDT);
	});

	test("a server line the local text lacks is still a conflict, naming the live note as its origin", async () => {
		env.server.put(PATH, "# Roundtrip\nLine edited by an agent.\n", "external");
		env.disk.set(VAULT_PATH, CRDT);
		env.downloader.setRelayTextProbe(async () => true);

		await env.downloader.downloadShare(SHARE, SERVER);

		expect(env.base()).toBeUndefined();
		expect(env.adapter.writeBinary).not.toHaveBeenCalled();
		expect(env.downloader.getConflicts()).toEqual([
			expect.objectContaining({ relativePath: PATH, localSource: "relay" }),
		]);
	});

	test("a local edit that differs from the relay too is reported as such", async () => {
		env.server.put(PATH, "other", "external");
		env.disk.set(VAULT_PATH, CRDT);
		env.downloader.setRelayTextProbe(async () => false);

		await env.downloader.downloadShare(SHARE, SERVER);

		expect(env.downloader.getConflicts()).toEqual([expect.objectContaining({ localSource: "device" })]);
	});

	test("a server version that moved between files-index and download is not adopted", async () => {
		env.server.put(PATH, EXTERNAL, "external");
		env.disk.set(VAULT_PATH, CRDT);
		env.server.staleIndex = env.server.index();
		env.server.put(PATH, "# Roundtrip\nRewritten.\n", "external");

		await env.downloader.downloadShare(SHARE, SERVER);

		expect(env.base()).toBeUndefined();
		expect(env.downloader.getConflicts()).toHaveLength(1);
	});

	test("with a base, a local edit is a conflict as before and the server copy is not fetched", async () => {
		env.baseStore.set(SHARE, { [PATH]: sha("# Roundtrip\n") });
		env.server.put(PATH, EXTERNAL, "external");
		env.disk.set(VAULT_PATH, CRDT);

		await env.downloader.downloadShare(SHARE, SERVER);

		expect(env.server.downloads).toBe(0);
		expect(env.base()).toBe(sha("# Roundtrip\n"));
		expect(env.downloader.getConflicts()).toHaveLength(1);
	});

	test("attachments are never compared or adopted", async () => {
		env.server.put("img.png", "abc", "external");
		env.disk.set(`${FOLDER}/img.png`, "abc + more");

		await env.downloader.downloadShare(SHARE, SERVER);

		expect(env.server.downloads).toBe(0);
		expect(env.downloader.getConflicts()).toHaveLength(1);
	});
});

// ─── 3. end to end ──────────────────────────────────────────────────────────

describe("fresh client: an ordinary edit reaches the sync protocol without manual steps", () => {
	test("reconcile waits, the downloader pass adopts the base, the edit is mirrored", async () => {
		const { clock, server, disk, downloader, writer, base } = setup();
		server.put(PATH, EXTERNAL, "external");
		disk.set(VAULT_PATH, CRDT);

		// Start: reconcile reaches the writer before the downloader's first pass.
		writer.reconcile([VAULT_PATH]);
		await writer.idle();
		expect(writer.pathsAwaitingInbound()).toEqual([VAULT_PATH]);

		await downloader.downloadShare(SHARE, SERVER);
		await writer.idle();
		await clock.advance(0);

		// The live text replaced the stale sync copy under If-Match of that copy.
		expect(server.writes).toEqual([
			{ path: PATH, content: CRDT, precondition: { ifMatchSha256: sha(EXTERNAL) } },
		]);
		expect(writer.pathsAwaitingInbound()).toEqual([]);
		expect(downloader.getConflicts()).toEqual([]);

		// The ordinary edit afterwards goes out on the debounce.
		disk.set(VAULT_PATH, EDITED);
		writer.notifyLocalChange(VAULT_PATH);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);

		expect(server.items.get(PATH)).toEqual({ content: EDITED, origin: "crdt" });
		expect(base()).toBe(sha(EDITED));
	});

	test("the edit made before the first pass is the one mirrored", async () => {
		const { clock, server, disk, downloader, writer } = setup();
		server.put(PATH, EXTERNAL, "external");
		disk.set(VAULT_PATH, EDITED);

		writer.notifyLocalChange(VAULT_PATH);
		await clock.advance(OUTBOUND_DEBOUNCE_MS);
		expect(server.writes).toHaveLength(0);

		await downloader.downloadShare(SHARE, SERVER);
		await writer.idle();
		await clock.advance(0);

		expect(server.items.get(PATH)).toEqual({ content: EDITED, origin: "crdt" });
	});
});

// ─── 4. "Use server version" ────────────────────────────────────
//
// It used to trash the local file: in a shared folder that delete reaches the
// CRDT and the note disappears for every member, and only this device got the
// sync copy back. Now the local text is replaced in place, as an ordinary edit.

describe("Use server version replaces the text in place", () => {
	const SERVER_TEXT = "# Roundtrip\nLine edited by an agent.\n";

	async function conflicted() {
		const env = setup();
		env.server.put(PATH, SERVER_TEXT, "external");
		env.disk.set(VAULT_PATH, CRDT);
		await env.downloader.downloadShare(SHARE, SERVER);
		expect(env.downloader.getConflicts()).toHaveLength(1);
		return env;
	}

	test("the note is never trashed; its text becomes the server bytes and the base the server sha", async () => {
		const env = await conflicted();

		await env.downloader.resolveTakeServer(SHARE, PATH);

		expect(env.trashFile).not.toHaveBeenCalled();
		expect(env.disk.get(VAULT_PATH)).toBe(SERVER_TEXT);
		expect(env.base()).toBe(sha(SERVER_TEXT));
		expect(env.downloader.getConflicts()).toEqual([]);
	});

	test("the next pass has no conflict and writes nothing; the writer pushes nothing", async () => {
		const env = await conflicted();
		await env.downloader.resolveTakeServer(SHARE, PATH);
		env.adapter.writeBinary.mockClear();
		const downloadsBefore = env.server.downloads;

		await env.downloader.downloadShare(SHARE, SERVER);
		env.writer.notifyLocalChange(VAULT_PATH);
		await env.clock.advance(OUTBOUND_DEBOUNCE_MS);
		await env.writer.idle();

		expect(env.downloader.getConflicts()).toEqual([]);
		expect(env.adapter.writeBinary).not.toHaveBeenCalled();
		expect(env.server.downloads).toBe(downloadsBefore);
		expect(env.server.writes).toEqual([]);
		expect(env.server.items.get(PATH)).toEqual({ content: SERVER_TEXT, origin: "external" });
	});

	test("a note with a live CRDT document gets the server text there, and the disk write is no new edit", async () => {
		const env = await conflicted();
		let crdtText = CRDT;
		const writingDuringDiskWrite: boolean[] = [];
		env.vault.modifyBinary.mockImplementation(async (file: TFile, data: ArrayBuffer) => {
			writingDuringDiskWrite.push(env.downloader.isInboundWriting(file.path));
			env.disk.set(file.path, textOf(data));
		});
		const released: string[] = [];
		env.downloader.setLiveTextTarget(async (vaultPath) => {
			expect(vaultPath).toBe(VAULT_PATH);
			return {
				replace: async (text) => {
					crdtText = text;
				},
				release: () => released.push(vaultPath),
			};
		});

		await env.downloader.resolveTakeServer(SHARE, PATH);

		expect(crdtText).toBe(SERVER_TEXT);
		expect(env.disk.get(VAULT_PATH)).toBe(SERVER_TEXT);
		expect(writingDuringDiskWrite).toEqual([true]);
		expect(env.downloader.isInboundWriting(VAULT_PATH)).toBe(false);
		expect(env.trashFile).not.toHaveBeenCalled();
		expect(released).toEqual([VAULT_PATH]);
	});

	test("without a live document the file is written as an ordinary edit (the modify handler carries it)", async () => {
		const env = await conflicted();
		const writingDuringDiskWrite: boolean[] = [];
		env.vault.modifyBinary.mockImplementation(async (file: TFile, data: ArrayBuffer) => {
			writingDuringDiskWrite.push(env.downloader.isInboundWriting(file.path));
			env.disk.set(file.path, textOf(data));
		});
		env.downloader.setLiveTextTarget(async () => null);

		await env.downloader.resolveTakeServer(SHARE, PATH);

		expect(writingDuringDiskWrite).toEqual([false]);
		expect(env.disk.get(VAULT_PATH)).toBe(SERVER_TEXT);
	});

	test("a failed disk write leaves the shared CRDT text and the conflict untouched", async () => {
		const env = await conflicted();
		let crdtText = CRDT;
		env.vault.modifyBinary.mockRejectedValueOnce(new Error("Disk full"));
		let released = 0;
		env.downloader.setLiveTextTarget(async () => ({
			replace: async (text) => {
				crdtText = text;
			},
			release: () => {
				released++;
			},
		}));

		await expect(env.downloader.resolveTakeServer(SHARE, PATH)).rejects.toThrow("Disk full");

		expect(crdtText).toBe(CRDT);
		expect(env.disk.get(VAULT_PATH)).toBe(CRDT);
		expect(env.base()).toBeUndefined();
		expect(env.downloader.getConflicts()).toHaveLength(1);
		expect(env.downloader.isInboundWriting(VAULT_PATH)).toBe(false);
		expect(released).toBe(1);
	});

	test("a note that cannot reach the relay keeps its text and the conflict", async () => {
		const env = await conflicted();
		env.downloader.setLiveTextTarget(async () => {
			throw new Error("the relay did not answer for this note; nothing was changed");
		});

		await expect(env.downloader.resolveTakeServer(SHARE, PATH)).rejects.toThrow("relay did not answer");

		expect(env.disk.get(VAULT_PATH)).toBe(CRDT);
		expect(env.base()).toBeUndefined();
		expect(env.downloader.getConflicts()).toHaveLength(1);
	});

	test("a failed download keeps the conflict and leaves the note untouched", async () => {
		const env = await conflicted();
		env.server.items.delete(PATH);

		await expect(env.downloader.resolveTakeServer(SHARE, PATH)).rejects.toThrow(RelayHttpError);

		expect(env.disk.get(VAULT_PATH)).toBe(CRDT);
		expect(env.base()).toBeUndefined();
		expect(env.downloader.getConflicts()).toHaveLength(1);
		expect(env.trashFile).not.toHaveBeenCalled();
	});
});
