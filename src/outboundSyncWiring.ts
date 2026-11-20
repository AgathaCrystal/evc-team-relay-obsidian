/**
 * Binds the OutboundSyncWriter to the plugin: folder shares, the vault, the
 * CRDT documents and the relay control plane.
 */

import { TFile } from "obsidian";
import type { Vault } from "obsidian";
import type { Clock } from "./Clock";
import { isCanvasDocument } from "./CanvasDocument";
import { sha256Hex } from "./contentDigest";
import { isDocument } from "./Document";
import { namedLogger } from "./logging";
import {
	OutboundSyncWriter,
	isOutboundSyncPath,
	type OutboundTarget,
	type ServerSyncItem,
} from "./OutboundSyncWriter";
import type { RelayOnPremShareClientManager } from "./RelayOnPremShareClientManager";
import { sameTextContent } from "./textEquivalence";
import { joinFolderPath, toFolderRelativePath } from "./vaultRootPath";
import { applyDiffToYText } from "./ytextDiff";
import type { ShareRegistry, VaultShare } from "./VaultShare";

const log = namedLogger("[OutboundSyncWiring]");

/** How often folder connection state is looked at to catch a (re)connect. */
export const RECONNECT_CHECK_MS = 15_000;

export function resolveOutboundTarget(
	shareRegistry: ShareRegistry,
	vaultPath: string,
): OutboundTarget | null {
	const folder = shareRegistry.shareFor(vaultPath);
	if (!folder) return null;
	const shareId = folder.entityGuid;
	const serverId = folder.config.onpremServerId;
	if (!shareId || !serverId) return null;
	const relativePath = toFolderRelativePath(vaultPath, folder.path);
	if (!relativePath) return null;
	return { shareId, serverId, relativePath };
}

/**
 * The file's text, but only once it is synced with the relay: an open note
 * whose live CRDT is connected, synced and saved to disk, or a closed note
 * whose disk text is the base this client last agreed on with the relay.
 */
export async function readRelaySyncedText(
	vault: Vault,
	shareRegistry: ShareRegistry,
	vaultPath: string,
): Promise<string | null> {
	const folder = shareRegistry.shareFor(vaultPath);
	if (!folder || !folder.isOnline) return null;
	const tfile = vault.getAbstractFileByPath(vaultPath);
	if (!(tfile instanceof TFile)) return null;
	const entry = folder.rootRelative.entryFor(tfile);
	if (!entry) return null;
	const disk = await vault.read(tfile);
	if (isDocument(entry)) {
		if (entry.isOnline && entry.isSynced && sameTextContent(entry.content, disk)) return disk;
		const base = await entry.getSyncBase();
		return base !== undefined && sameTextContent(base, disk) ? disk : null;
	}
	if (isCanvasDocument(entry)) {
		return entry.isSynced ? disk : null;
	}
	return null;
}

/** Transaction origin of "Use server version", distinct from any editor or document. */
export const TAKE_SERVER_ORIGIN = "take-server-version";

/**
 * A function that replaces a note's live CRDT text as an ordinary edit:
 * the relay carries it to every member of the share and an open
 * editor follows it. Waits for the locally persisted CRDT state first so the
 * diff is taken against the real text, not an empty document. Resolves null
 * when the path has no CRDT document (not in a folder share, not a note); the
 * caller then writes the file instead.
 */
export async function liveTextTarget(
	vault: Vault,
	shareRegistry: ShareRegistry,
	vaultPath: string,
): Promise<((text: string) => void) | null> {
	const folder = shareRegistry.shareFor(vaultPath);
	if (!folder) return null;
	const tfile = vault.getAbstractFileByPath(vaultPath);
	if (!(tfile instanceof TFile)) return null;
	const entry = folder.rootRelative.entryFor(tfile);
	if (!entry || !isDocument(entry)) return null;
	await entry.awaitFirstSync();
	return (text) => applyDiffToYText(entry.crdtDoc, text, TAKE_SERVER_ORIGIN);
}

export function createOutboundSyncWriter(opts: {
	vault: Vault;
	clock: Clock;
	shareRegistry: ShareRegistry;
	clientManager: RelayOnPremShareClientManager;
	baseStore: Map<string, Record<string, string>>;
}): OutboundSyncWriter {
	const { vault, clock, shareRegistry, clientManager, baseStore } = opts;
	return new OutboundSyncWriter({
		clock,
		baseStore,
		resolveTarget: (vaultPath) => resolveOutboundTarget(shareRegistry, vaultPath),
		readSyncedText: (vaultPath) => readRelaySyncedText(vault, shareRegistry, vaultPath),
		supportsSyncOrigin: async (serverId) => {
			const client = clientManager.getClient(serverId);
			if (!client) return false;
			const info = await client.getServerInfo();
			return info.features?.sync_write_origin === true;
		},
		getFilesIndex: async (serverId, shareId): Promise<ServerSyncItem[]> =>
			clientManager.getFilesIndex(serverId, shareId),
		syncWrite: (target, content, precondition, mime) =>
			clientManager.syncWriteFile(
				target.serverId,
				target.shareId,
				target.relativePath,
				content,
				precondition,
				mime,
				{ origin: "crdt" },
			),
		sha256: (text) => sha256Hex(new TextEncoder().encode(text).buffer),
		supportsSyncDelete: async (serverId) => {
			const client = clientManager.getClient(serverId);
			if (!client) return false;
			const info = await client.getServerInfo();
			return info.features?.sync_delete === true;
		},
		syncDelete: (target, ifMatchSha256) =>
			clientManager.syncDeleteFile(target.serverId, target.shareId, target.relativePath, ifMatchSha256),
		existsInVault: (vaultPath) => vault.getAbstractFileByPath(vaultPath) !== null,
	});
}


/**
 * Reconcile each folder share when it comes online: at start and after every
 * reconnect, once its CRDT has freshly synced. Returns a stop function.
 */
export function watchShareReconnects(opts: {
	vault: Vault;
	clock: Clock;
	shareRegistry: ShareRegistry;
	writer: OutboundSyncWriter;
}): () => void {
	const { vault, clock, shareRegistry, writer } = opts;
	const online = new WeakMap<VaultShare, boolean>();

	const reconcileFolder = (folder: VaultShare): void => {
		void folder
			.onceFreshlySynced()
			.then(async () => {
				const paths = vault
					.getFiles()
					.map((file) => file.path)
					.filter((path) => isOutboundSyncPath(path) && shareRegistry.shareFor(path) === folder);
				log("Reconciling share with the sync protocol", { folder: folder.path, files: paths.length });
				writer.reconcile(paths);
				// Deletes made while offline: an entry neither on disk nor in the
				// CRDT goes from the sync protocol too.
				const shareId = folder.entityGuid;
				const serverId = folder.config.onpremServerId;
				if (!shareId || !serverId) return;
				const toVaultPath = (relativePath: string): string => joinFolderPath(folder.path, relativePath);
				// A share that left this vault meanwhile counts as live: a retried
				// scan must never read an unloaded share as "everything deleted".
				const stillShared = (): boolean => !!shareRegistry.locate((sf) => sf === folder);
				await writer.reconcileDeletes({ shareId, serverId }, toVaultPath, (relativePath) =>
					!stillShared() ||
					vault.getAbstractFileByPath(toVaultPath(relativePath)) !== null ||
					folder.folderIndex.recordFor(relativePath) !== undefined,
				);
			})
			.catch((err: unknown) => {
				log("Reconcile skipped", { error: err instanceof Error ? err.message : String(err) });
			});
	};

	const check = (): void => {
		shareRegistry.each((folder) => {
			const isOnline = folder.isOnline;
			const wasOnline = online.get(folder) ?? false;
			online.set(folder, isOnline);
			if (isOnline && !wasOnline) reconcileFolder(folder);
		});
	};

	const timer = clock.scheduleInterval(check, RECONNECT_CHECK_MS);
	check();
	return () => clock.cancelInterval(timer);
}
