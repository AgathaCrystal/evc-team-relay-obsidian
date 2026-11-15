/**
 * A client that was ONLINE while the server moved a share's roots
 * into `artifacts/` (relocate-artifacts) kept some old roots on disk (their
 * destination already existed locally, or the old copy was not empty) and
 * published them back into `web_folder_items` from disk. The share's CRDT no
 * longer tracks them; applyServerMoves() only runs once per start, so for an
 * online client followedMoveSkips stays empty and nothing filtered them.
 *
 * Pinned here: server-move leftovers (live structural ones and
 * followedMoveSkips) never reach `web_folder_items`, ordinary folders and
 * still-tracked roots do, and the corrected list is pushed without any new
 * vault event.
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";
import * as Y from "yjs";
import { TFile, TFolder, type Vault } from "obsidian";
import { VaultShare } from "../src/VaultShare";
import { FolderIndex } from "../src/FolderIndex";
import { makeFolderRecord, makeDocumentRecord } from "../src/ItemKinds";
import type { AttachmentSyncSettings } from "../src/AttachmentSyncSettings";
import { WebSyncManager } from "../src/WebSyncManager";
import type { RelayOnPremShareClientManager } from "../src/RelayOnPremShareClientManager";
import type { UpdateShareRequest, WebFolderEntry } from "../src/RelayOnPremShareClient";
import { registerWebFolderExclusion } from "../src/webFolderExclusions";

const SHARE = "Shared";

const MockTFolder = TFolder as unknown as new (path: string) => TFolder;
const MockTFile = TFile as unknown as new (path: string) => TFile;

/** The share's synced records after the server moved aaaa1111 and bbbb2222 under artifacts/. */
function postMoveIndex(extra: Record<string, ReturnType<typeof makeFolderRecord>> = {}): FolderIndex {
	const doc = new Y.Doc();
	doc.transact(() => {
		const meta = doc.getMap("filemeta_v0");
		meta.set("artifacts", makeFolderRecord("fa"));
		meta.set("artifacts/aaaa1111", makeFolderRecord("f1"));
		meta.set("artifacts/aaaa1111/report.md", makeDocumentRecord("d1"));
		meta.set("artifacts/bbbb2222", makeFolderRecord("f2"));
		meta.set("Projects", makeFolderRecord("fp"));
		meta.set("Projects/plan.md", makeDocumentRecord("dp"));
		for (const [path, record] of Object.entries(extra)) meta.set(path, record);
	});
	return new FolderIndex(doc, SHARE, new Map(), {
		subscribe: () => () => {},
	} as unknown as AttachmentSyncSettings);
}

/** An on-disk tree under SHARE: files by path, plus extra empty folders. */
function disk(files: string[], emptyFolders: string[] = []) {
	const nodes = new Map<string, TFile | TFolder>();
	const folderAt = (path: string): TFolder => {
		const existing = nodes.get(path);
		if (existing instanceof TFolder) return existing;
		const folder = new MockTFolder(path);
		nodes.set(path, folder);
		const parent = path.split("/").slice(0, -1).join("/");
		if (parent) folderAt(parent).children.push(folder);
		return folder;
	};
	const root = folderAt(SHARE);
	for (const path of emptyFolders) folderAt(`${SHARE}/${path}`);
	for (const path of files) {
		const full = `${SHARE}/${path}`;
		const file = new MockTFile(full);
		nodes.set(full, file);
		folderAt(full.split("/").slice(0, -1).join("/")).children.push(file);
	}
	const vault = {
		getAbstractFileByPath: jest.fn((path: string) => nodes.get(path) ?? null),
		getRoot: jest.fn(() => root),
		read: jest.fn(async () => ""),
	} as unknown as Vault;
	const inScope = () => [...nodes.entries()].filter(([path]) => path !== SHARE).map(([, node]) => node);
	return { vault, inScope };
}

/** A live VaultShare as far as leftover detection goes; followedMoveSkips empty = online client. */
function onlineShare(
	index: FolderIndex,
	inScope: () => Array<TFile | TFolder>,
	skips: string[] = [],
	extra: Record<string, unknown> = {},
): VaultShare {
	const share = Object.create(VaultShare.prototype) as VaultShare;
	Object.assign(share, {
		path: SHARE,
		folderIndex: index,
		isTornDown: false,
		followedMoveSkips: new Set<string>(skips),
		vaultFilesInScope: inScope,
		...extra,
	});
	return share;
}

/** An in-memory entry bound to `entryPath`, like a Document the client already tracks. */
function boundEntry(guid: string, entryPath: string) {
	return {
		entityGuid: guid,
		entryPath,
		relocate(newPath: string) {
			this.entryPath = newPath;
		},
	};
}

function makeManager(vault: Vault) {
	const updateShare = jest.fn(async (_serverId: string, _shareId: string, _req: UpdateShareRequest) => ({}));
	const clients = {
		updateShare,
		syncFolderFileContent: jest.fn(async () => undefined),
		getClient: jest.fn(),
	} as unknown as RelayOnPremShareClientManager;
	const manager = new WebSyncManager(vault, clients);
	manager.registerAutoSyncShare(SHARE, "share-1", "server-1", "folder", "contenthub");
	const lastItems = (): WebFolderEntry[] => {
		const calls = updateShare.mock.calls;
		return calls[calls.length - 1][2].web_folder_items ?? [];
	};
	return { manager, updateShare, lastItems };
}

const paths = (items: WebFolderEntry[]) => items.map((item) => item.path).sort();

describe("web_folder_items after a server move seen by an online client", () => {
	const unregister: Array<() => void> = [];
	afterEach(() => {
		unregister.splice(0).forEach((stop) => stop());
		jest.useRealTimers();
	});

	test("old roots left on disk are not published; destination, ordinary folders are", async () => {
		const { vault, inScope } = disk(
			[
				// destination already on disk, old copy not identical: kept, untracked
				"aaaa1111/report.md",
				"artifacts/aaaa1111/report.md",
				"Projects/plan.md",
			],
			// old root became empty, its destination is tracked
			["bbbb2222", "artifacts/bbbb2222"],
		);
		unregister.push(registerWebFolderExclusion(onlineShare(postMoveIndex(), inScope)));
		const { manager, lastItems } = makeManager(vault);

		await manager.syncFolderStructureToWeb(SHARE, "server-1", "share-1");

		expect(paths(lastItems())).toEqual([
			"Projects",
			"Projects/plan.md",
			"artifacts",
			"artifacts/aaaa1111",
			"artifacts/aaaa1111/report.md",
			"artifacts/bbbb2222",
		]);
		manager.destroy();
	});

	test("a tool-named root the share still tracks stays published", async () => {
		const { vault, inScope } = disk(["cccc3333/notes.md", "artifacts/aaaa1111/report.md"]);
		const index = postMoveIndex({
			cccc3333: makeFolderRecord("f3"),
			"artifacts/cccc3333": makeFolderRecord("f4"),
		});
		unregister.push(registerWebFolderExclusion(onlineShare(index, inScope)));
		const { manager, lastItems } = makeManager(vault);

		await manager.syncFolderStructureToWeb(SHARE, "server-1", "share-1");

		expect(paths(lastItems())).toContain("cccc3333/notes.md");
		manager.destroy();
	});

	test("roots skipped at startup (followedMoveSkips) are not published either", async () => {
		const { vault, inScope } = disk(["dddd4444/mine.md", "Projects/plan.md"]);
		unregister.push(registerWebFolderExclusion(onlineShare(postMoveIndex(), inScope, ["dddd4444"])));
		const { manager, lastItems } = makeManager(vault);

		await manager.syncFolderStructureToWeb(SHARE, "server-1", "share-1");

		expect(paths(lastItems())).toEqual(["Projects", "Projects/plan.md"]);
		manager.destroy();
	});

	test("leftovers stay out of adoption as well", () => {
		const { inScope } = disk(["aaaa1111/report.md", "Projects/plan.md", "eeee5555/new.md"], ["bbbb2222"]);
		const share = onlineShare(postMoveIndex(), inScope);
		// eeee5555 has no artifacts/eeee5555: an ordinary new root, adopted as usual.
		expect([...share.serverMoveRemnantRoots()].sort()).toEqual(["aaaa1111", "bbbb2222"]);
	});

	describe("the stale list already on the server is replaced", () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		test("a change in leftovers pushes the corrected list with no vault event", async () => {
			const { vault, inScope } = disk(["aaaa1111/report.md", "artifacts/aaaa1111/report.md"]);
			const share = onlineShare(postMoveIndex(), inScope);
			const { manager, updateShare, lastItems } = makeManager(vault);

			unregister.push(registerWebFolderExclusion(share));
			(share as unknown as { refreshServerMoveRemnants(): void }).refreshServerMoveRemnants();
			await jest.advanceTimersByTimeAsync(31_000);

			expect(updateShare).toHaveBeenCalledTimes(1);
			expect(paths(lastItems())).not.toContain("aaaa1111");
			expect(paths(lastItems())).not.toContain("aaaa1111/report.md");

			// Same leftovers on the next pass: nothing new to push.
			(share as unknown as { refreshServerMoveRemnants(): void }).refreshServerMoveRemnants();
			await jest.advanceTimersByTimeAsync(31_000);
			expect(updateShare).toHaveBeenCalledTimes(1);
			manager.destroy();
		});
	});

	describe("an entry still bound to the old path (doc keeps syncing the stale copy)", () => {
		const refresh = (share: VaultShare) =>
			(share as unknown as { refreshServerMoveRemnants(): void }).refreshServerMoveRemnants();

		test("is re-bound to the path the share records for its guid", () => {
			const { vault, inScope } = disk(["aaaa1111/report.md", "artifacts/aaaa1111/report.md"]);
			const entry = boundEntry("d1", "aaaa1111/report.md");
			const share = onlineShare(postMoveIndex(), inScope, [], {
				vaultApi: vault,
				trackedEntries: new Map([["d1", entry]]),
			});

			refresh(share);

			expect(entry.entryPath).toBe("artifacts/aaaa1111/report.md");
		});

		test("stays put while the recorded path is not on disk yet (the tree scan renames it)", () => {
			const { vault, inScope } = disk(["aaaa1111/report.md"], ["artifacts/aaaa1111"]);
			const entry = boundEntry("d1", "aaaa1111/report.md");
			const share = onlineShare(postMoveIndex(), inScope, [], {
				vaultApi: vault,
				trackedEntries: new Map([["d1", entry]]),
			});

			refresh(share);

			expect(entry.entryPath).toBe("aaaa1111/report.md");
		});

		test("entries outside leftovers are never moved", () => {
			const { vault, inScope } = disk(["Projects/plan.md", "artifacts/aaaa1111/report.md", "aaaa1111/x.md"]);
			const entry = boundEntry("d1", "Projects/plan.md");
			const share = onlineShare(postMoveIndex(), inScope, [], {
				vaultApi: vault,
				trackedEntries: new Map([["d1", entry]]),
			});

			refresh(share);

			expect(entry.entryPath).toBe("Projects/plan.md");
		});
	});
});
