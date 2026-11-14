"use strict";

/**
 * What a share's "Local folder" row shows outside the share's own settings
 * page: in the share modal ("Relay: share settings", Manage shares) and in
 * Settings > Shares > share details.
 *
 * The ">7 days" block (Show files / Retry) lives only on the share page, so a
 * row whose files have been pending for more than 7 days must say so and link
 * there, the same way "Folder not found" links there with Fix folder.
 */
export type LocalFolderRow =
	| { kind: "missing"; page: string }
	| { kind: "stuck"; count: number; page: string }
	| { kind: "syncing" };

export function localFolderRow(folder: {
	entityGuid: string;
	folderMissing: boolean;
	stuckUploadPaths(): string[];
}): LocalFolderRow {
	const page = `/shared-folders?id=${folder.entityGuid}`;
	if (folder.folderMissing) return { kind: "missing", page };
	const count = folder.stuckUploadPaths().length;
	return count > 0 ? { kind: "stuck", count, page } : { kind: "syncing" };
}
