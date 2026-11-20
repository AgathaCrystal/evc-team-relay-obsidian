/**
 * Telling this user's own delete or rename apart from an echo.
 * Kept free of runtime imports so it can be unit-tested on its own.
 */

import { toFolderRelativePath } from "./vaultRootPath";
import type { ShareRegistry } from "./VaultShare";

/**
 * Whether a vault delete or rename of `vaultPath` is this user's own action.
 * A peer's delete or move reaches this vault through the CRDT:
 * the entry leaves the folder index first and the plugin then removes the
 * file, so at event time the index no longer holds it. A local delete fires
 * while the index still does. Inbound-downloader removals are echoes too.
 */
export function isLocalRemoval(
	shareRegistry: ShareRegistry,
	vaultPath: string,
	isInboundWriting: (vaultPath: string) => boolean,
): boolean {
	if (isInboundWriting(vaultPath)) return false;
	const folder = shareRegistry.shareFor(vaultPath);
	if (!folder?.folderIndex) return false;
	const vpath = toFolderRelativePath(vaultPath, folder.path);
	if (!vpath) return false;
	if (folder.folderIndex.recordFor(vpath) !== undefined) return true;
	// A folder without a record of its own still counts by its contents.
	let hasChild = false;
	const prefix = `${vpath}/`;
	folder.folderIndex.eachRecord((_meta, path) => {
		if (path.startsWith(prefix)) hasChild = true;
	});
	return hasChild;
}
