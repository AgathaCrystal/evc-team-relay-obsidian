"use strict";

/**
 * Paths that must never appear in a folder share's `web_folder_items`, even
 * though they still exist on disk.
 *
 * `web_folder_items` is built from the local folder tree. After a server-side
 * move (relocate-artifacts) a client can keep the old root on disk: its
 * destination already existed locally, or the old copy still holds files that
 * are not byte-identical. The share no longer tracks that root, so publishing
 * it to the web brings the moved roots back on the public page and makes the
 * next relocation run refuse with a destination collision (#e8240f53).
 *
 * Every builder of the list goes through collectWebFolderItems(), which asks
 * this registry, so a new call site cannot forget the filter.
 */

export interface WebFolderExclusionSource {
	/**
	 * A predicate over vault paths, computed once per listing, or null when
	 * this source excludes nothing right now.
	 */
	webFolderExclusion(): ((vaultPath: string) => boolean) | null;
}

const sources = new Set<WebFolderExclusionSource>();
const listeners = new Set<(sharePath: string) => void>();

export function registerWebFolderExclusion(source: WebFolderExclusionSource): () => void {
	sources.add(source);
	return () => {
		sources.delete(source);
	};
}

/** One predicate over all sources, for a single listing; null when none apply. */
export function currentWebFolderExclusion(): ((vaultPath: string) => boolean) | null {
	const predicates: Array<(vaultPath: string) => boolean> = [];
	for (const source of sources) {
		try {
			const predicate = source.webFolderExclusion();
			if (predicate) predicates.push(predicate);
		} catch (e: unknown) {
			console.warn("[webFolderExclusions] exclusion source failed", e);
		}
	}
	if (predicates.length === 0) return null;
	return (vaultPath) => predicates.some((predicate) => predicate(vaultPath));
}

/** Called by WebSyncManager to re-push a share's list when its exclusions change. */
export function onWebFolderExclusionsChanged(listener: (sharePath: string) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function notifyWebFolderExclusionsChanged(sharePath: string): void {
	for (const listener of listeners) {
		try {
			listener(sharePath);
		} catch (e: unknown) {
			console.warn("[webFolderExclusions] listener failed", e);
		}
	}
}
