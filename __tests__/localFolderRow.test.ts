import * as fs from "fs";
import * as path from "path";
import { TFile, TFolder, type TAbstractFile } from "obsidian";
import { VaultShare } from "../src/VaultShare";
import { localFolderRow } from "../src/localFolderRow";
import { englishPhrasebook, phrasebooksByLanguage } from "../src/wording/phrasebook";

/**
 * The ">7 days" block (Show files / Retry) lives only on the share's own
 * settings page. A healthy on-prem share is reached through the share modal
 * ("Relay: share settings", Manage shares) or Settings > Shares > share
 * details; both said "Connected and syncing" with a file pending for 8 days
 * and neither linked to the page (0.1.34 candidate eb3c9c8, scenario (d)).
 */

interface RecordedRow {
	name: string;
	desc: string;
	buttons: { text: string; click?: () => void }[];
}

// Obsidian's Setting row, the host boundary the modal draws with. Defined in
// the (hoisted) factory; rows land in `FakeSetting.rows`.
jest.mock("obsidian", () => {
	class FakeSetting {
		static rows: FakeSetting[] = [];
		name = "";
		desc = "";
		buttons: { text: string; click?: () => void }[] = [];
		constructor(_containerEl: unknown) {
			FakeSetting.rows.push(this);
		}
		setName(name: string) {
			this.name = name;
			return this;
		}
		setDesc(desc: string) {
			this.desc = desc;
			return this;
		}
		addButton(cb: (button: unknown) => void) {
			const entry: { text: string; click?: () => void } = { text: "" };
			this.buttons.push(entry);
			const button = {
				buttonEl: { addClass: () => {} },
				setButtonText(text: string) {
					entry.text = text;
					return button;
				},
				setCta: () => button,
				onClick(fn: () => void) {
					entry.click = fn;
					return button;
				},
			};
			cb(button);
			return this;
		}
	}
	return { ...jest.requireActual("obsidian"), Setting: FakeSetting };
});

// The folder picker is a Svelte component this row never opens.
jest.mock("../src/ui/FolderPathPickerModal", () => ({ FolderPathPickerModal: class {} }));

// eslint-disable-next-line @typescript-eslint/no-require-imports -- the mocked module's extra export
const FakeSetting = (require("obsidian") as { Setting: { rows: RecordedRow[] } }).Setting;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the Setting mock is in place
const { ShareManagementModal } = require("../src/ui/ShareManagementModal") as typeof import("../src/ui/ShareManagementModal");

const DAY = 24 * 60 * 60 * 1000;
const GUID = "11111111-1111-4111-8111-111111111111";
const PAGE = `/shared-folders?id=${GUID}`;

// The Jest mock (mocks/obsidian.ts) gives TFile/TFolder path constructors the real typings lack.
const MockFile = TFile as unknown as new (path: string) => TFile;
const MockFolder = TFolder as unknown as new (path: string, children?: TAbstractFile[]) => TFolder;

/** A vault holding `Shared/stuck.md`, or nothing when the folder is gone. */
function makeVault(folderPresent: boolean) {
	const nodes = new Map<string, TAbstractFile>();
	if (folderPresent) {
		const folder = new MockFolder("Shared", [new MockFile("Shared/stuck.md")]);
		nodes.set("Shared", folder);
		for (const child of folder.children) nodes.set(child.path, child);
	}
	nodes.set("/", new MockFolder("/", []));
	return {
		getAbstractFileByPath: (p: string) => nodes.get(p) ?? null,
		getAllLoadedFiles: () => [...nodes.values()],
		getRoot: () => new MockFolder("", []),
	};
}

/** A real VaultShare whose only pending upload was claimed `ageDays` ago. */
function shareWithClaimAged(ageDays: number, folderMissing = false): VaultShare {
	const share = Object.create(VaultShare.prototype) as VaultShare;
	Object.assign(share, {
		path: "Shared",
		entityGuid: GUID,
		vaultApi: makeVault(!folderMissing),
		uploadClaims: new Map([["stuck.md", "g-stuck"]]),
		uploadClaimAges: new Map([["g-stuck", Date.now() - ageDays * DAY]]),
	});
	return share;
}

describe("localFolderRow on a real share", () => {
	it("a claim pending 8 days makes the row 'stuck' with a link to the share page", () => {
		expect(localFolderRow(shareWithClaimAged(8))).toEqual({ kind: "stuck", count: 1, page: PAGE });
	});

	it("control: a claim pending 6 days leaves the row 'syncing'", () => {
		expect(localFolderRow(shareWithClaimAged(6))).toEqual({ kind: "syncing" });
	});

	it("a missing folder stays 'missing' (Fix folder) even with a stuck claim", () => {
		expect(localFolderRow(shareWithClaimAged(8, true))).toEqual({ kind: "missing", page: PAGE });
	});
});

describe("share modal: Local folder row", () => {
	function renderRow(share: VaultShare) {
		FakeSetting.rows = [];
		const showSettingsTab = jest.fn().mockResolvedValue(undefined);
		const close = jest.fn();
		const modal = Object.create(ShareManagementModal.prototype) as InstanceType<typeof ShareManagementModal>;
		Object.assign(modal, {
			selectedShare: { id: GUID },
			contentEl: { createEl: jest.fn() },
			plugin: {
				shareRegistry: { locate: (pred: (s: VaultShare) => boolean) => (pred(share) ? share : undefined) },
				showSettingsTab,
			},
			close,
		});
		(modal as unknown as { renderLocalFolderSection(): void }).renderLocalFolderSection();
		expect(FakeSetting.rows).toHaveLength(1);
		return { row: FakeSetting.rows[0], showSettingsTab, close };
	}

	it("8 days: shows the count and 'Show files', which opens this share's page", () => {
		const { row, showSettingsTab, close } = renderRow(shareWithClaimAged(8));
		expect(row.desc).toBe("1 file not uploaded for more than 7 days");
		const show = row.buttons.find((b) => b.text === "Show files");
		expect(show).toBeDefined();
		show!.click!();
		expect(close).toHaveBeenCalled();
		expect(showSettingsTab).toHaveBeenCalledWith(PAGE);
	});

	it("control, 6 days: 'Connected and syncing' and no link button", () => {
		const { row } = renderRow(shareWithClaimAged(6));
		expect(row.desc).toBe("Connected and syncing");
		expect(row.buttons.map((b) => b.text)).toEqual(["Disconnect"]);
	});

	it("missing folder keeps 'Fix folder' to the same page", () => {
		const { row, showSettingsTab } = renderRow(shareWithClaimAged(8, true));
		expect(row.desc).toMatch(/^Folder not found/);
		row.buttons.find((b) => b.text === "Fix folder")!.click!();
		expect(showSettingsTab).toHaveBeenCalledWith(PAGE);
	});
});

describe("share details (Settings > Shares): Local folder block", () => {
	// No harness mounts ShareDetailView (it loads members/invites from the
	// server on mount), so its wiring is pinned at the source; the decision it
	// renders is localFolderRow, covered above on a real share.
	const src = fs.readFileSync(path.join(__dirname, "..", "src", "components", "ShareDetailView.svelte"), "utf8");
	const from = src.indexOf('uiText("shareDetail.localFolder.heading")');
	const markup = src.slice(from, src.indexOf("<!-- Members -->", from));

	it("derives the row from localFolderRow", () => {
		expect(src).toContain("localFolderRow(localFolder)");
		expect(src).toMatch(/localFolderStuck = state\?\.kind === "stuck" \? state\.count : 0;/);
	});

	it("shows the count and a 'Show files' button that opens this share's page", () => {
		expect(from).toBeGreaterThan(-1);
		expect(markup).toMatch(/\{:else if localFolderStuck > 0\}\s*<span[^>]*>\{uiText\(localFolderStuck === 1 \? "shareDetail\.localFolder\.stuckStatusOne" : "shareDetail\.localFolder\.stuckStatusOther", \{ count: localFolderStuck \}\)\}/);
		expect(markup).toMatch(/\{:else if localFolderStuck > 0\}\s*<button[^>]*on:click=\{fixFolder\}[^>]*>\{uiText\("shareDetail\.localFolder\.stuckButton"\)\}/);
		expect(src).toMatch(/function fixFolder\(\) \{\s*void live\.showSettingsTab\(`\/shared-folders\?id=\$\{share\.id\}`\)/);
	});

	it("has the copy in English and Russian, worded like the >7 days block", () => {
		expect(englishPhrasebook["shareDetail.localFolder.stuckStatusOne"]).toBe("{count} file not uploaded for more than 7 days");
		expect(englishPhrasebook["shareDetail.localFolder.stuckStatusOther"]).toBe("{count} files not uploaded for more than 7 days");
		expect(englishPhrasebook["shareDetail.localFolder.stuckButton"]).toBe("Show files");
		for (const key of ["shareDetail.localFolder.stuckStatusOne", "shareDetail.localFolder.stuckStatusOther", "shareDetail.localFolder.stuckButton"] as const) {
			expect(phrasebooksByLanguage.ru?.[key]).toBeTruthy();
		}
	});
});
