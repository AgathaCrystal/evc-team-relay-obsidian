/**
 * Sync Conflicts Modal
 *
 * Lists files InboundFileDownloader refused to overwrite because the local
 * content diverged from what it last wrote, and lets the user pick a side:
 * "Use server version" (deletes the local file so the next sync writes the
 * server copy fresh) or "Keep local" (acknowledges today's server version
 * without touching local content, so the guard stops nagging until the
 * server side changes again).
 */

import { App, Modal, Notice, Setting } from "obsidian";
import type TeamRelayPlugin from "../main";
import { confirmDialog } from "./dialogs";
import { setDestructiveButton } from "./destructiveButton";
import type { SyncConflict } from "../InboundFileDownloader";

/** Where the conflict's local text came from, as a description prefix. */
function localSourceText(source: SyncConflict["localSource"]): string {
	if (source === "relay") return "Local: the shared live note from the relay, not an edit made here. ";
	if (source === "device") return "Local: edited on this device. ";
	return "";
}

export class SyncConflictsModal extends Modal {
	constructor(app: App, private plugin: TeamRelayPlugin) {
		super(app);
		this.setTitle("Team relay sync conflicts");
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		const conflicts = this.plugin.inboundFileDownloader?.getConflicts() ?? [];

		if (conflicts.length === 0) {
			contentEl.createEl("p", {
				text: "No unresolved sync conflicts.",
				cls: "relay-onprem-empty",
			});
			return;
		}

		contentEl.createEl("p", {
			text: `${conflicts.length} file${conflicts.length === 1 ? "" : "s"} on this device ` +
				`differ${conflicts.length === 1 ? "s" : ""} from the relay's sync copy and ` +
				`${conflicts.length === 1 ? "was" : "were"} not overwritten. Pick a side for each:`,
		});

		const list = contentEl.createDiv({ cls: "relay-onprem-share-list" });

		for (const conflict of conflicts) {
			const setting = new Setting(list)
				.setName(conflict.vaultPath)
				.setDesc(
					`${localSourceText(conflict.localSource)}Detected ` +
						`${new Date(conflict.detectedAt).toLocaleString()}`,
				);

			setting.addButton((button) => {
				setDestructiveButton(button).setButtonText("Use server version").onClick(async () => {
					const ok = await confirmDialog(
						this.app,
						conflict.localSource === "relay"
							? `"${conflict.vaultPath}" is the shared live note. Replacing it moves ` +
								`it to trash, which removes it from the shared folder for everyone ` +
								`in the share, and then downloads the relay's sync copy in its ` +
								`place; lines that exist only in the live note are lost. Continue?`
							: `Discard local changes to "${conflict.vaultPath}" and replace it with the ` +
								`relay version on the next sync?`,
					);
					if (!ok) return;
					await this.plugin.inboundFileDownloader?.resolveTakeServer(
						conflict.shareId,
						conflict.relativePath,
					);
					new Notice(`Team Relay: will re-download "${conflict.relativePath}" from the relay.`);
					this.render();
				});
			});

			setting.addButton((button) => {
				button.setButtonText("Keep local").setCta().onClick(() => {
					this.plugin.inboundFileDownloader?.resolveKeepLocal(
						conflict.shareId,
						conflict.relativePath,
					);
					new Notice(`Team Relay: keeping local "${conflict.relativePath}".`);
					this.render();
				});
			});
		}
	}
}
