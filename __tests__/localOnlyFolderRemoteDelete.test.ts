/**
 * A peer removing or moving a shared folder must not send this client's
 * local-only files in that folder to the trash.
 *
 * Scenario: share with folder `R/`, "Other files" off. Client A holds
 * `R/local.xyz`, which the share never synced. Client B moves `R/n.md` to
 * `artifacts/R/n.md` and removes the record of `R` (relocate-artifacts), or
 * deletes `R` with its notes. On A, pruneUntrackedFiles() used to call
 * trashLocal("R") on the whole folder, so `R/local.xyz` ended up in
 * `.trash/R/local.xyz`.
 *
 * Expected: the file stays where it is, so `R/` stays on A's disk. The kept
 * folder is not published back into the share (adoption) nor listed in the
 * web index.
 *
 * The disk is a tree of the mocked TFile/TFolder nodes; trashLocal() takes a
 * node and everything under it, the way Obsidian's adapter does.
 */

import { describe, test, expect, jest } from "@jest/globals";
import * as Y from "yjs";
import { TFile, TFolder } from "obsidian";
import { VaultShare } from "../src/VaultShare";
import { FolderIndex } from "../src/FolderIndex";
import { makeDocumentRecord, makeFolderRecord } from "../src/ItemKinds";
import type { AttachmentSyncSettings } from "../src/AttachmentSyncSettings";
import { registerWebFolderExclusion } from "../src/webFolderExclusions";
import { collectWebFolderItems } from "../src/vaultRootPath";

type DeleteOp = { filePath: string; completion: Promise<unknown> };
type Node = TFile | TFolder;

function makeFile(path: string): TFile {
	const file = Object.create(TFile.prototype) as TFile;
	file.path = path;
	file.name = path.slice(path.lastIndexOf("/") + 1);
	file.extension = file.name.slice(file.name.lastIndexOf(".") + 1);
	file.basename = file.name.slice(0, file.name.lastIndexOf("."));
	return file;
}

function makeFolder(path: string): TFolder {
	const folder = Object.create(TFolder.prototype) as TFolder;
	folder.path = path;
	folder.name = path.slice(path.lastIndexOf("/") + 1);
	folder.children = [];
	return folder;
}

function childrenOf(folder: TFolder): Node[] {
	return folder.children.filter((c): c is Node => c instanceof TFile || c instanceof TFolder);
}

class Peer {
	doc = new Y.Doc();
	index: FolderIndex;
	root: TFolder;
	/** Every vault path trashLocal() sent to `.trash`, descendants included. */
	trash: string[] = [];
	share: VaultShare;

	constructor(public folder: string) {
		this.root = makeFolder(folder);
		this.index = new FolderIndex(this.doc, folder, new Map(), {
			subscribe: () => () => {},
			isFileTypeAllowed: () => true,
		} as unknown as AttachmentSyncSettings);
		this.share = Object.create(VaultShare.prototype) as VaultShare;
		Object.assign(this.share, {
			path: folder,
			folderIndex: this.index,
			uploadClaims: new Map(),
			trackedEntries: new Map(),
			attachmentSettings: { isFileTypeAllowed: () => true },
			_liveProvider: { synced: true },
			_localDb: { synced: true },
			vaultFilesInScope: () => this.all().filter((f) => this.share.isSyncableVaultFile(f)),
			vaultApi: {
				adapter: {
					trashLocal: async (path: string) => {
						const node = this.find(path);
						if (!node) throw new Error(`ENOENT ${path}`);
						for (const gone of this.subtree(node)) this.trash.push(gone.path);
						this.detach(node);
					},
					list: async (path: string) => {
						const node = this.find(path);
						if (!(node instanceof TFolder)) throw new Error(`ENOENT ${path}`);
						return {
							files: node.children.filter((c) => c instanceof TFile).map((c) => c.path),
							folders: node.children.filter((c) => c instanceof TFolder).map((c) => c.path),
						};
					},
				},
			},
			log: jest.fn(),
			debug: jest.fn(),
			warn: jest.fn(),
		});
	}

	private abs(vpath: string): string {
		return `${this.folder}/${vpath}`;
	}

	all(node: TFolder = this.root): Node[] {
		return childrenOf(node).flatMap((c) => (c instanceof TFolder ? [c, ...this.all(c)] : [c]));
	}

	private subtree(node: Node): Node[] {
		return node instanceof TFolder ? [node, ...this.all(node)] : [node];
	}

	private find(path: string): Node | undefined {
		if (path === this.folder) return this.root;
		return this.all().find((n) => n.path === path);
	}

	private parentOf(path: string): TFolder {
		const parent = path.slice(0, path.lastIndexOf("/"));
		const node = this.find(parent);
		if (!(node instanceof TFolder)) throw new Error(`no folder ${parent}`);
		return node;
	}

	private detach(node: Node): void {
		const parent = this.parentOf(node.path);
		parent.children = parent.children.filter((c) => c !== node);
	}

	/** Puts a folder on disk, whatever its name looks like. */
	addFolder(vpath: string): void {
		this.addLocal(`${vpath}/placeholder.tmp`);
		const placeholder = this.find(this.abs(`${vpath}/placeholder.tmp`));
		if (placeholder) this.detach(placeholder);
	}

	/** Puts a file or (no extension) folder on disk, creating parents. */
	addLocal(vpath: string): void {
		const parts = vpath.split("/");
		let parent = this.root;
		for (let i = 0; i < parts.length; i++) {
			const path = this.abs(parts.slice(0, i + 1).join("/"));
			const existing = childrenOf(parent).find((c) => c.path === path);
			if (existing instanceof TFolder) {
				parent = existing;
				continue;
			}
			const last = i === parts.length - 1;
			const node: Node = last && parts[i].includes(".") ? makeFile(path) : makeFolder(path);
			parent.children.push(node);
			if (node instanceof TFolder) parent = node;
		}
	}

	addSynced(vpath: string): void {
		this.addLocal(vpath);
		this.index.put(
			vpath,
			vpath.endsWith(".md") ? makeDocumentRecord(`guid-${vpath}`) : makeFolderRecord(`guid-${vpath}`),
		);
	}

	/** The local rename scanFileTree() applies before pruning. */
	renameOnDisk(from: string, to: string): void {
		const node = this.find(this.abs(from));
		if (!node) throw new Error(`no ${from}`);
		this.detach(node);
		this.addLocal(to);
	}

	removeOnDisk(vpath: string): void {
		const node = this.find(this.abs(vpath));
		if (node) this.detach(node);
	}

	paths(): string[] {
		return this.all()
			.map((f) => f.path.slice(this.folder.length + 1))
			.sort();
	}

	trashed(): string[] {
		return this.trash.map((p) => p.slice(this.folder.length + 1)).sort();
	}

	async prune(): Promise<string[]> {
		const prune = (this.share as unknown as {
			pruneUntrackedFiles(remotePaths: string[], diffLog: string[]): DeleteOp[];
		}).pruneUntrackedFiles.bind(this.share);
		const ops = prune([], []);
		await Promise.all(ops.map((op) => op.completion));
		return ops.map((op) => op.filePath).sort();
	}
}

function sync(a: Peer, b: Peer): void {
	Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
	Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
}

/** Both peers hold `R/` and `R/n.md`; A also holds the never-shared `R/local.xyz`. */
function setup(): [Peer, Peer] {
	const a = new Peer("Team");
	const b = new Peer("Shared");
	b.addSynced("keep.md");
	b.addSynced("R");
	b.addSynced("R/n.md");
	sync(a, b);
	a.addLocal("keep.md");
	a.addLocal("R/n.md");
	a.addLocal("R/local.xyz");
	return [a, b];
}

/** B relocates R/ under artifacts/ the way relocate-artifacts does. */
function relocate(b: Peer): void {
	b.doc.transact(() => {
		b.index.put("artifacts", makeFolderRecord("guid-artifacts"));
		b.index.put("artifacts/R", makeFolderRecord("guid-artifacts/R"));
		b.index.put("artifacts/R/n.md", makeDocumentRecord("guid-R/n.md"));
		b.index.delete("R/n.md");
		b.index.delete("R");
	});
	b.renameOnDisk("R/n.md", "artifacts/R/n.md");
	b.removeOnDisk("R");
}

describe("local-only files in a folder a peer removes or moves.", () => {

	test("the share does not sync R/local.xyz (Other files off)", () => {
		const [a] = setup();
		expect(a.index.isSyncable("R/local.xyz")).toBe(false);
		expect(a.index.tracks("R/local.xyz")).toBe(false);
	});

	test("peer moves R/ under artifacts/: local-only file stays on disk, not in the trash", async () => {
		const [a, b] = setup();
		relocate(b);
		sync(a, b);
		// scanFileTree() follows the note's rename before it prunes.
		a.renameOnDisk("R/n.md", "artifacts/R/n.md");

		await a.prune();

		expect(a.trashed()).not.toContain("R/local.xyz");
		expect(a.paths()).toContain("R/local.xyz");
		expect(a.paths()).toContain("artifacts/R/n.md");
		expect(a.paths()).not.toContain("R/n.md");
	});

	test("peer deletes R/: the note goes, the local-only file stays", async () => {
		const [a, b] = setup();
		b.doc.transact(() => {
			b.index.delete("R/n.md");
			b.index.delete("R");
		});
		sync(a, b);

		await a.prune();

		expect(a.trashed()).toEqual(["R/n.md"]);
		expect(a.paths()).toEqual(["R", "R/local.xyz", "keep.md"].sort());
	});

	test("a local-only file deeper down keeps every folder above it", async () => {
		const [a, b] = setup();
		b.addSynced("R/sub");
		b.addSynced("R/sub/m.md");
		sync(a, b);
		a.addLocal("R/sub/m.md");
		a.addLocal("R/sub/deep.xyz");
		b.doc.transact(() => {
			for (const vpath of ["R/sub/m.md", "R/sub", "R/n.md", "R"]) b.index.delete(vpath);
		});
		sync(a, b);

		await a.prune();

		expect(a.trashed()).toEqual(["R/n.md", "R/sub/m.md"]);
		expect(a.paths()).toEqual(["R", "R/local.xyz", "R/sub", "R/sub/deep.xyz", "keep.md"].sort());
	});

	test("a folder holding only synced notes is still removed whole", async () => {
		const a = new Peer("Team");
		const b = new Peer("Shared");
		b.addSynced("keep.md");
		b.addSynced("R");
		b.addSynced("R/sub");
		b.addSynced("R/n.md");
		b.addSynced("R/sub/m.md");
		sync(a, b);
		for (const vpath of ["keep.md", "R/n.md", "R/sub/m.md"]) a.addLocal(vpath);
		b.doc.transact(() => {
			for (const vpath of ["R/sub/m.md", "R/sub", "R/n.md", "R"]) b.index.delete(vpath);
		});
		sync(a, b);

		expect(await a.prune()).toEqual(["R", "R/n.md", "R/sub", "R/sub/m.md"]);
		expect(a.paths()).toEqual(["keep.md"]);
		expect(a.trashed()).toEqual(["R", "R/n.md", "R/sub", "R/sub/m.md"]);
	});

	test("a kept folder is neither published back into the share nor listed on the web", async () => {
		const [a, b] = setup();
		relocate(b);
		sync(a, b);
		a.renameOnDisk("R/n.md", "artifacts/R/n.md");
		await a.prune();
		expect(a.paths()).toContain("R");

		// Adoption: what adoptLocalFiles() would publish leaves R out.
		const share = a.share as unknown as { adoptableFiles(): Node[] };
		const adoptable = share.adoptableFiles().map((f) => f.path.slice("Team/".length)).sort();
		expect(adoptable).not.toContain("R");
		expect(adoptable).toEqual(["artifacts", "artifacts/R", "artifacts/R/n.md", "keep.md"]);

		// Web index: the listing every builder uses leaves R and its files out.
		const unregister = registerWebFolderExclusion(a.share);
		try {
			const listed = collectWebFolderItems(a.root, "Team").map((item) => item.path);
			expect(listed).not.toContain("R");
			expect(listed).toEqual(expect.arrayContaining(["artifacts", "artifacts/R", "artifacts/R/n.md", "keep.md"]));
		} finally {
			unregister();
		}

		// A second pass leaves it alone and reports nothing.
		expect(await a.prune()).toEqual([]);
		expect(a.paths()).toContain("R/local.xyz");
	});

	test("a removed folder that regains a note is published again", async () => {
		const [a, b] = setup();
		b.doc.transact(() => {
			b.index.delete("R/n.md");
			b.index.delete("R");
		});
		sync(a, b);
		await a.prune();
		a.addLocal("R/new.md");

		const share = a.share as unknown as { adoptableFiles(): Node[] };
		const adoptable = share.adoptableFiles().map((f) => f.path.slice("Team/".length)).sort();
		expect(adoptable).toEqual(expect.arrayContaining(["R", "R/new.md"]));
	});

	test("a dotted subfolder the share cannot classify does not pin its parents", async () => {
		const a = new Peer("Team");
		const b = new Peer("Shared");
		b.addSynced("keep.md");
		b.addSynced("R");
		b.addFolder("R/v1.2");
		b.index.put("R/v1.2", makeFolderRecord("guid-R/v1.2"));
		b.addSynced("R/v1.2/x.md");
		sync(a, b);
		a.addLocal("keep.md");
		a.addFolder("R/v1.2");
		a.addLocal("R/v1.2/x.md");
		b.doc.transact(() => {
			for (const vpath of ["R/v1.2/x.md", "R/v1.2", "R"]) b.index.delete(vpath);
		});
		sync(a, b);
		expect(a.index.isSyncable("R/v1.2")).toBe(false);

		await a.prune();

		expect(a.paths()).toEqual(["keep.md"]);
		expect(a.trashed()).toEqual(["R", "R/v1.2", "R/v1.2/x.md"]);
	});
});
