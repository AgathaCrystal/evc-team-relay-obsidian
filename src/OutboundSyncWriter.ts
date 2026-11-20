/**
 * Outbound sync-protocol writer.
 *
 * Mirrors what people write in Obsidian into the share's sync protocol
 * (PUT /v1/shares/{id}/sync-write), so readers of files-index/download --
 * agents among them -- see it. Before this, a local edit or a new note only
 * reached the CRDT; the sync protocol was fed solely by a manual web publish.
 *
 * Every write is tagged `X-Sync-Origin: crdt`: the text is the CRDT's, every
 * other client already has it through the relay, so their InboundFileDownloader
 * skips the item instead of writing it into a possibly open note again.
 *
 * Rules (owner decision on the card):
 * - Trigger: a local edit or create (never an inbound-download echo), debounced
 *   per path; the latest content of a path wins. Only .md and .canvas.
 * - Only text that is synced with the relay is pushed (`readSyncedText`).
 * - New file: `If-None-Match: *`.
 * - If-Match: the server item's sha, but only when that item is a crdt mirror
 *   or equals the base this client itself pulled (`baseStore`, shared with the
 *   InboundFileDownloader). An external version the client has not pulled yet
 *   is never overwritten: the path waits for the downloader's next pass.
 * - 412: re-read; equal to local -> record base; otherwise one retry under
 *   the same rules. 429: honour Retry-After.
 * - Enabled only when the server advertises `features.sync_write_origin`.
 *
 * Deletes: the server does not infer a delete from the nav tree,
 * so a local delete is reported explicitly (DELETE /sync-write, If-Match).
 * - Source: a local delete of a file or folder (every files-index entry under
 *   it) and the old path of a rename; never an inbound or remote-delete echo
 *   (the wiring filters those). Same debounce and pacing as writes.
 * - If-Match: the server sha, only when the item is a crdt mirror or equals
 *   this client's base. An external version the client has not pulled is
 *   never deleted.
 * - 404: already gone, base cleared. 412: nothing deleted, one re-read under
 *   the same rules. A path that exists in the vault again is left to writes.
 * - Reconnect: an entry that is neither on disk nor in the CRDT is deleted
 *   under the same rules (deletes made while offline).
 * - Enabled only when the server advertises `features.sync_delete`.
 */

import type { Clock } from "./Clock";
import { namedLogger } from "./logging";
import { RelayHttpError, isTransientRelayFailure } from "./relayRequestErrors";

const log = namedLogger("[OutboundSyncWriter]");

export const OUTBOUND_DEBOUNCE_MS = 3_000;
/** Text not yet synced with the relay: look again this often... */
export const NOT_SYNCED_RETRY_MS = 5_000;
/** ...for at most this many times (2 min), then the next edit or reconcile retries. */
export const NOT_SYNCED_MAX_ATTEMPTS = 24;
/** Below the server's 60/minute sync-write limit, so a reconcile does not hit 429. */
export const MIN_WRITE_INTERVAL_MS = 1_100;
export const DEFAULT_RETRY_AFTER_MS = 60_000;
export const MAX_RETRY_AFTER_MS = 120_000;
export const TRANSIENT_RETRY_MS = 30_000;
/** A files-index read is reused this long, so a reconcile reads it once per share. */
export const INDEX_TTL_MS = 5_000;
export const CAPABILITY_TTL_MS = 10 * 60_000;
export const CAPABILITY_ERROR_TTL_MS = 60_000;
/**
 * A delete that could not reach the server (server-info, files-index or the
 * DELETE itself failed) is retried this many times, ~10 min at
 * TRANSIENT_RETRY_MS; after that the reconnect reconciliation catches it.
 */
export const DELETE_MAX_ATTEMPTS = 20;

export const SYNC_ORIGIN_CRDT = "crdt";

/** A files-index entry as the writer needs it. `origin` absent = external. */
export interface ServerSyncItem {
	path: string;
	sha256: string;
	origin?: string;
}

export type OutboundDecision =
	| { kind: "in-sync" }
	| { kind: "create" }
	| { kind: "write"; ifMatch: string }
	| { kind: "await-inbound" };

/**
 * The decision table (local / base / server / origin).
 *
 * - no server item                      -> create (If-None-Match: *)
 * - server sha == local                 -> in sync, record the base
 * - server item is a crdt mirror        -> write, If-Match server sha
 * - server sha == base we pulled        -> write, If-Match server sha
 * - external version we have not pulled -> wait for the inbound downloader
 */
export function decideOutboundWrite(
	localSha: string,
	baseSha: string | undefined,
	server: ServerSyncItem | undefined,
): OutboundDecision {
	if (!server) return { kind: "create" };
	if (server.sha256 === localSha) return { kind: "in-sync" };
	if (server.origin === SYNC_ORIGIN_CRDT) return { kind: "write", ifMatch: server.sha256 };
	if (baseSha !== undefined && server.sha256 === baseSha) {
		return { kind: "write", ifMatch: server.sha256 };
	}
	return { kind: "await-inbound" };
}

export type OutboundDeleteDecision =
	| { kind: "gone" }
	| { kind: "delete"; ifMatch: string }
	| { kind: "keep-external" };

/**
 * The delete table (base / server / origin).
 *
 * - no server item                      -> already gone
 * - server item is a crdt mirror        -> delete, If-Match server sha
 * - server sha == base we pulled        -> delete, If-Match server sha
 * - external version we have not pulled -> keep it
 */
export function decideOutboundDelete(
	baseSha: string | undefined,
	server: ServerSyncItem | undefined,
): OutboundDeleteDecision {
	if (!server) return { kind: "gone" };
	if (server.origin === SYNC_ORIGIN_CRDT) return { kind: "delete", ifMatch: server.sha256 };
	if (baseSha !== undefined && server.sha256 === baseSha) {
		return { kind: "delete", ifMatch: server.sha256 };
	}
	return { kind: "keep-external" };
}

export function isOutboundSyncPath(path: string): boolean {
	return /\.(md|canvas)$/i.test(path);
}

export function outboundMime(path: string): string {
	return /\.canvas$/i.test(path) ? "application/json" : "text/markdown; charset=utf-8";
}

export interface OutboundTarget {
	shareId: string;
	serverId: string;
	/** Path inside the share, as files-index names it. */
	relativePath: string;
}

export type SyncWritePrecondition = { create: true } | { ifMatchSha256: string };

/** The writer's boundaries: the vault/CRDT side and the relay server. */
export interface OutboundSyncDeps {
	clock: Pick<Clock, "now" | "scheduleTimeout" | "cancelTimeout">;
	/** Folder share holding this vault path, or null when it is not shared. */
	resolveTarget(vaultPath: string): OutboundTarget | null;
	/** The file's text once it is synced with the relay; null while it is not. */
	readSyncedText(vaultPath: string): Promise<string | null>;
	supportsSyncOrigin(serverId: string): Promise<boolean>;
	getFilesIndex(serverId: string, shareId: string): Promise<ServerSyncItem[]>;
	syncWrite(
		target: OutboundTarget,
		content: string,
		precondition: SyncWritePrecondition,
		mime: string,
	): Promise<{ sha256: string }>;
	sha256(text: string): Promise<string>;
	/** shareId -> relativePath -> sha the client last agreed with the server on. */
	baseStore: Map<string, Record<string, string>>;
	supportsSyncDelete(serverId: string): Promise<boolean>;
	syncDelete(target: OutboundTarget, ifMatchSha256: string): Promise<void>;
	/** Whether a file or folder exists at this vault path right now. */
	existsInVault(vaultPath: string): boolean;
}

interface QueuedPath {
	/** Reconcile entries do not wait for unsynced text: the next edit retries them. */
	reconcile: boolean;
}

interface PendingDelete {
	target: OutboundTarget;
	/** A folder: every files-index entry under `target.relativePath`. */
	folder: boolean;
	/**
	 * Reconcile: the entry must still be absent from disk and CRDT. Checked
	 * again right before every DELETE, retries included.
	 */
	stillGone?: () => boolean;
	/** Failed attempts so far (server-info, files-index or DELETE). */
	attempts?: number;
}

export class OutboundSyncWriter {
	private debounceTimers = new Map<string, number>();
	private notSyncedAttempts = new Map<string, number>();
	private queue = new Map<string, QueuedPath>();
	private draining: Promise<void> | null = null;
	/** vaultPath -> shareId: paths waiting for the downloader to pull an external version. */
	private awaitingInbound = new Map<string, string>();
	private indexCache = new Map<string, { at: number; items: Map<string, ServerSyncItem> }>();
	private capability = new Map<string, { until: number; value: boolean }>();
	private deleteCapability = new Map<string, { until: number; value: boolean }>();
	/** vaultPath -> delete waiting for its debounce or the queue. */
	private pendingDeletes = new Map<string, PendingDelete>();
	/** shareId -> timer of a delete reconciliation waiting to retry its scan. */
	private reconcileRetryTimers = new Map<string, number>();
	private lastWriteAt = Number.NEGATIVE_INFINITY;
	private pausedUntil = 0;
	private destroyed = false;

	constructor(private readonly deps: OutboundSyncDeps) {}

	/** A local edit or create of `vaultPath` (never an inbound-download echo). */
	notifyLocalChange(vaultPath: string): void {
		if (this.destroyed || !isOutboundSyncPath(vaultPath)) return;
		if (!this.deps.resolveTarget(vaultPath)) return;
		// A re-create after a delete: the write wins.
		this.pendingDeletes.delete(vaultPath);
		this.notSyncedAttempts.delete(vaultPath);
		this.schedule(vaultPath, OUTBOUND_DEBOUNCE_MS, false);
	}

	/**
	 * A local delete of `vaultPath` (or the old path of a rename); a folder
	 * removes every files-index entry under it. Never an inbound or
	 * remote-delete echo: the caller filters those.
	 */
	notifyLocalDelete(vaultPath: string, folder: boolean): void {
		if (this.destroyed) return;
		const target = this.deps.resolveTarget(vaultPath);
		if (!target) return;
		if (folder && target.relativePath === "") return;
		// A pending write of the deleted path would bring it back.
		this.cancelPendingWrites(vaultPath, folder);
		this.pendingDeletes.set(vaultPath, { target, folder });
		this.schedule(vaultPath, OUTBOUND_DEBOUNCE_MS, false);
	}

	/**
	 * Reconnect reconciliation of deletes: every files-index entry of the share
	 * that is neither on disk nor in the CRDT (`isLive` false) is deleted under
	 * the usual rules. Catches deletes made while offline. A scan that cannot
	 * read server-info or the files-index is retried on its own, up to
	 * DELETE_MAX_ATTEMPTS, without waiting for the next reconnect.
	 */
	async reconcileDeletes(
		share: { shareId: string; serverId: string },
		toVaultPath: (relativePath: string) => string,
		isLive: (relativePath: string) => boolean,
	): Promise<void> {
		this.cancelReconcileRetry(share.shareId);
		await this.reconcileDeletesPass(share, toVaultPath, isLive, 0);
	}

	private async reconcileDeletesPass(
		share: { shareId: string; serverId: string },
		toVaultPath: (relativePath: string) => string,
		isLive: (relativePath: string) => boolean,
		failures: number,
	): Promise<void> {
		if (this.destroyed) return;
		let index: Map<string, ServerSyncItem>;
		try {
			const supported = await this.serverSupportsDelete(share.serverId);
			if (supported === false) return;
			if (supported === undefined) throw new Error("server-info unavailable");
			index = await this.readIndex({ ...share, relativePath: "" }, true);
		} catch (err: unknown) {
			if (this.destroyed) return;
			const attempts = failures + 1;
			const error = err instanceof Error ? err.message : String(err);
			if (attempts >= DELETE_MAX_ATTEMPTS) {
				log("Delete reconciliation kept failing, leaving it to the next reconnect", {
					shareId: share.shareId,
					error,
				});
				return;
			}
			log("Delete reconciliation postponed", { shareId: share.shareId, error, attempts });
			this.cancelReconcileRetry(share.shareId);
			const timer = this.deps.clock.scheduleTimeout(() => {
				this.reconcileRetryTimers.delete(share.shareId);
				void this.reconcileDeletesPass(share, toVaultPath, isLive, attempts);
			}, TRANSIENT_RETRY_MS);
			this.reconcileRetryTimers.set(share.shareId, timer);
			return;
		}
		const base = this.deps.baseStore.get(share.shareId) ?? {};
		for (const item of index.values()) {
			if (isLive(item.path)) continue;
			const vaultPath = toVaultPath(item.path);
			if (this.debounceTimers.has(vaultPath) || this.queue.has(vaultPath)) continue;
			if (decideOutboundDelete(base[item.path], item).kind !== "delete") continue;
			this.pendingDeletes.set(vaultPath, {
				target: { ...share, relativePath: item.path },
				folder: false,
				stillGone: () => !isLive(item.path),
			});
			this.enqueue(vaultPath, true);
		}
	}

	private cancelReconcileRetry(shareId: string): void {
		const timer = this.reconcileRetryTimers.get(shareId);
		if (timer === undefined) return;
		this.deps.clock.cancelTimeout(timer);
		this.reconcileRetryTimers.delete(shareId);
	}

	/**
	 * Start/reconnect reconciliation: compare every given path of a share with
	 * the server and push what diverged (edits made while offline, or by
	 * clients that do not write the sync protocol yet).
	 */
	reconcile(vaultPaths: string[]): void {
		if (this.destroyed) return;
		for (const vaultPath of vaultPaths) {
			if (!isOutboundSyncPath(vaultPath)) continue;
			if (this.debounceTimers.has(vaultPath) || this.queue.has(vaultPath)) continue;
			this.enqueue(vaultPath, true);
		}
	}

	/** The inbound downloader finished a pass over `shareId`: retry what waited for it. */
	onInboundPass(shareId: string): void {
		if (this.destroyed) return;
		this.indexCache.delete(shareId);
		for (const [vaultPath, waitingShare] of Array.from(this.awaitingInbound)) {
			if (waitingShare !== shareId) continue;
			this.awaitingInbound.delete(vaultPath);
			this.enqueue(vaultPath, false);
		}
	}

	/** Paths currently waiting for an external version to be pulled (diagnostics/tests). */
	pathsAwaitingInbound(): string[] {
		return Array.from(this.awaitingInbound.keys());
	}

	/** Resolves once the queue is empty (tests, shutdown). */
	async idle(): Promise<void> {
		while (this.draining) await this.draining;
	}

	destroy(): void {
		this.destroyed = true;
		for (const timer of this.debounceTimers.values()) this.deps.clock.cancelTimeout(timer);
		this.debounceTimers.clear();
		for (const timer of this.reconcileRetryTimers.values()) this.deps.clock.cancelTimeout(timer);
		this.reconcileRetryTimers.clear();
		this.queue.clear();
		this.awaitingInbound.clear();
		this.indexCache.clear();
		this.pendingDeletes.clear();
	}

	private cancelPendingWrites(vaultPath: string, folder: boolean): void {
		const hit = (path: string): boolean =>
			path === vaultPath || (folder && path.startsWith(`${vaultPath}/`));
		for (const [path, timer] of Array.from(this.debounceTimers)) {
			if (!hit(path) || this.pendingDeletes.has(path)) continue;
			this.deps.clock.cancelTimeout(timer);
			this.debounceTimers.delete(path);
		}
		for (const path of Array.from(this.queue.keys())) {
			if (hit(path) && !this.pendingDeletes.has(path)) this.queue.delete(path);
		}
		for (const path of Array.from(this.notSyncedAttempts.keys())) {
			if (hit(path)) this.notSyncedAttempts.delete(path);
		}
		for (const path of Array.from(this.awaitingInbound.keys())) {
			if (hit(path)) this.awaitingInbound.delete(path);
		}
	}

	private schedule(vaultPath: string, delayMs: number, reconcile: boolean): void {
		const existing = this.debounceTimers.get(vaultPath);
		if (existing !== undefined) this.deps.clock.cancelTimeout(existing);
		const timer = this.deps.clock.scheduleTimeout(() => {
			this.debounceTimers.delete(vaultPath);
			this.enqueue(vaultPath, reconcile);
		}, delayMs);
		this.debounceTimers.set(vaultPath, timer);
	}

	private enqueue(vaultPath: string, reconcile: boolean): void {
		if (this.destroyed) return;
		const queued = this.queue.get(vaultPath);
		// A real edit outranks a reconcile entry for the same path.
		this.queue.set(vaultPath, { reconcile: (queued?.reconcile ?? true) && reconcile });
		if (!this.draining) {
			this.draining = this.drain().finally(() => {
				this.draining = null;
			});
		}
	}

	private async drain(): Promise<void> {
		while (this.queue.size > 0 && !this.destroyed) {
			const [vaultPath, entry] = this.queue.entries().next().value as [string, QueuedPath];
			this.queue.delete(vaultPath);
			try {
				await this.flush(vaultPath, entry);
			} catch (err: unknown) {
				log("Outbound write failed", {
					vaultPath,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	private async flush(vaultPath: string, entry: QueuedPath): Promise<void> {
		const pendingDelete = this.pendingDeletes.get(vaultPath);
		if (pendingDelete) {
			this.pendingDeletes.delete(vaultPath);
			await this.flushDelete(vaultPath, pendingDelete);
			return;
		}
		const target = this.deps.resolveTarget(vaultPath);
		if (!target) return;
		if (!(await this.serverSupportsOrigin(target.serverId))) return;

		const text = await this.deps.readSyncedText(vaultPath);
		if (text === null) {
			if (entry.reconcile) return;
			const attempts = (this.notSyncedAttempts.get(vaultPath) ?? 0) + 1;
			if (attempts >= NOT_SYNCED_MAX_ATTEMPTS) {
				this.notSyncedAttempts.delete(vaultPath);
				log("Text never settled with the relay, giving up until the next edit", { vaultPath });
				return;
			}
			this.notSyncedAttempts.set(vaultPath, attempts);
			this.schedule(vaultPath, NOT_SYNCED_RETRY_MS, false);
			return;
		}
		this.notSyncedAttempts.delete(vaultPath);

		const localSha = await this.deps.sha256(text);
		const index = await this.readIndex(target, false);
		await this.apply(vaultPath, target, text, localSha, index.get(target.relativePath), false);
	}

	private async apply(
		vaultPath: string,
		target: OutboundTarget,
		text: string,
		localSha: string,
		server: ServerSyncItem | undefined,
		retried: boolean,
	): Promise<void> {
		const base = this.deps.baseStore.get(target.shareId)?.[target.relativePath];
		const decision = decideOutboundWrite(localSha, base, server);

		if (decision.kind === "in-sync") {
			this.recordBase(target, localSha);
			this.awaitingInbound.delete(vaultPath);
			return;
		}
		if (decision.kind === "await-inbound") {
			log("External version not pulled yet, waiting for the inbound downloader", {
				vaultPath,
				serverSha: server?.sha256,
				base,
			});
			this.awaitingInbound.set(vaultPath, target.shareId);
			return;
		}

		const precondition: SyncWritePrecondition =
			decision.kind === "create" ? { create: true } : { ifMatchSha256: decision.ifMatch };
		await this.awaitWriteSlot();
		if (this.destroyed) return;
		try {
			this.lastWriteAt = this.deps.clock.now();
			const result = await this.deps.syncWrite(target, text, precondition, outboundMime(vaultPath));
			const writtenSha = result.sha256 || localSha;
			this.recordBase(target, writtenSha);
			this.cacheItem(target, { path: target.relativePath, sha256: writtenSha, origin: SYNC_ORIGIN_CRDT });
			this.awaitingInbound.delete(vaultPath);
			log("Mirrored local text into the sync protocol", { vaultPath, sha256: writtenSha });
		} catch (err: unknown) {
			const status = err instanceof RelayHttpError ? err.status : undefined;
			if (status === 412) {
				this.indexCache.delete(target.shareId);
				if (retried) {
					log("Precondition failed twice, leaving it to the next edit or reconcile", { vaultPath });
					return;
				}
				const fresh = await this.readIndex(target, true);
				await this.apply(vaultPath, target, text, localSha, fresh.get(target.relativePath), true);
				return;
			}
			if (status === 429) {
				const retryAfter = (err as RelayHttpError).retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
				const delay = Math.min(Math.max(retryAfter, 0), MAX_RETRY_AFTER_MS);
				this.pausedUntil = this.deps.clock.now() + delay;
				log("Rate limited, retrying after Retry-After", { vaultPath, delay });
				this.schedule(vaultPath, delay, false);
				return;
			}
			if (isTransientRelayFailure(err)) {
				this.schedule(vaultPath, TRANSIENT_RETRY_MS, false);
				return;
			}
			throw err;
		}
	}

	private async flushDelete(vaultPath: string, request: PendingDelete): Promise<void> {
		const { target } = request;
		let index: Map<string, ServerSyncItem>;
		try {
			const supported = await this.serverSupportsDelete(target.serverId);
			if (supported === false) return;
			if (supported === undefined) throw new Error("server-info unavailable");
			index = await this.readIndex(target, false);
		} catch (err: unknown) {
			this.retryDelete(vaultPath, request, err);
			return;
		}
		const rel = target.relativePath;
		if (!request.folder) {
			await this.applyDelete(vaultPath, request, index.get(rel), false);
			return;
		}
		const victims = Array.from(index.values()).filter((item) => item.path.startsWith(`${rel}/`));
		for (const item of victims) {
			if (this.destroyed) return;
			const itemVaultPath = vaultPath + item.path.slice(rel.length);
			const itemRequest: PendingDelete = { target: { ...target, relativePath: item.path }, folder: false };
			await this.applyDelete(itemVaultPath, itemRequest, item, false);
		}
	}

	/** Whether the delete still applies: nothing came back on disk or (reconcile) in the CRDT. */
	private deleteStillWanted(vaultPath: string, request: PendingDelete): boolean {
		if (this.destroyed || this.deps.existsInVault(vaultPath)) return false;
		return !request.stillGone || request.stillGone();
	}

	private async applyDelete(
		vaultPath: string,
		request: PendingDelete,
		server: ServerSyncItem | undefined,
		retried: boolean,
	): Promise<void> {
		const { target } = request;
		// Created again meanwhile (undo, rename back, a peer's re-create): writes own the path now.
		if (!this.deleteStillWanted(vaultPath, request)) return;
		const base = this.deps.baseStore.get(target.shareId)?.[target.relativePath];
		const decision = decideOutboundDelete(base, server);
		if (decision.kind === "gone") {
			this.clearBase(target);
			return;
		}
		if (decision.kind === "keep-external") {
			log("External version not pulled, not deleting it", { vaultPath, serverSha: server?.sha256, base });
			return;
		}

		await this.awaitWriteSlot();
		// The pacing wait is long enough for the entry to come back.
		if (!this.deleteStillWanted(vaultPath, request)) return;
		try {
			this.lastWriteAt = this.deps.clock.now();
			await this.deps.syncDelete(target, decision.ifMatch);
			this.forgetServerItem(target);
			log("Removed deleted file from the sync protocol", { vaultPath, sha256: decision.ifMatch });
		} catch (err: unknown) {
			const status = err instanceof RelayHttpError ? err.status : undefined;
			if (status === 404) {
				this.forgetServerItem(target);
				return;
			}
			if (status === 412) {
				this.indexCache.delete(target.shareId);
				if (retried) {
					log("Delete precondition failed twice, leaving the server version", { vaultPath });
					return;
				}
				let fresh: Map<string, ServerSyncItem>;
				try {
					fresh = await this.readIndex(target, true);
				} catch (readErr: unknown) {
					this.retryDelete(vaultPath, request, readErr);
					return;
				}
				await this.applyDelete(vaultPath, request, fresh.get(target.relativePath), true);
				return;
			}
			if (status === 429 || isTransientRelayFailure(err)) {
				this.retryDelete(vaultPath, request, err);
				return;
			}
			throw err;
		}
	}

	/**
	 * Keep a delete that failed before reaching a verdict and try it again
	 * later, with its liveness check. A 429 waits for Retry-After.
	 */
	private retryDelete(vaultPath: string, request: PendingDelete, err: unknown): void {
		if (this.destroyed) return;
		const attempts = (request.attempts ?? 0) + 1;
		const status = err instanceof RelayHttpError ? err.status : undefined;
		const error = err instanceof Error ? err.message : String(err);
		if (attempts >= DELETE_MAX_ATTEMPTS) {
			log("Delete kept failing, leaving it to the reconnect reconciliation", { vaultPath, status, error });
			return;
		}
		let delay = TRANSIENT_RETRY_MS;
		if (status === 429) {
			const retryAfter = (err as RelayHttpError).retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
			delay = Math.min(Math.max(retryAfter, 0), MAX_RETRY_AFTER_MS);
			this.pausedUntil = this.deps.clock.now() + delay;
		}
		log("Delete postponed", { vaultPath, status, error, delay, attempts });
		this.pendingDeletes.set(vaultPath, { ...request, attempts });
		this.schedule(vaultPath, delay, false);
	}

	/** The entry is gone from the server: drop it from the cached index and the base. */
	private forgetServerItem(target: OutboundTarget): void {
		this.indexCache.get(target.shareId)?.items.delete(target.relativePath);
		this.clearBase(target);
	}

	private async awaitWriteSlot(): Promise<void> {
		const readyAt = Math.max(this.lastWriteAt + MIN_WRITE_INTERVAL_MS, this.pausedUntil);
		const wait = readyAt - this.deps.clock.now();
		if (wait <= 0) return;
		await new Promise<void>((resolve) => {
			this.deps.clock.scheduleTimeout(resolve, wait);
		});
	}

	private async serverSupportsOrigin(serverId: string): Promise<boolean> {
		const now = this.deps.clock.now();
		const cached = this.capability.get(serverId);
		if (cached && cached.until > now) return cached.value;
		let value = false;
		let ttl = CAPABILITY_TTL_MS;
		try {
			value = await this.deps.supportsSyncOrigin(serverId);
		} catch {
			ttl = CAPABILITY_ERROR_TTL_MS;
		}
		this.capability.set(serverId, { until: now + ttl, value });
		return value;
	}

	/**
	 * Whether the server accepts sync deletes; `undefined` when server-info
	 * could not be read. Not cached then, so a retried delete asks again.
	 */
	private async serverSupportsDelete(serverId: string): Promise<boolean | undefined> {
		const now = this.deps.clock.now();
		const cached = this.deleteCapability.get(serverId);
		if (cached && cached.until > now) return cached.value;
		let value: boolean;
		try {
			value = await this.deps.supportsSyncDelete(serverId);
		} catch {
			return undefined;
		}
		this.deleteCapability.set(serverId, { until: now + CAPABILITY_TTL_MS, value });
		return value;
	}

	private async readIndex(target: OutboundTarget, fresh: boolean): Promise<Map<string, ServerSyncItem>> {
		const now = this.deps.clock.now();
		const cached = this.indexCache.get(target.shareId);
		if (!fresh && cached && now - cached.at < INDEX_TTL_MS) return cached.items;
		const items = await this.deps.getFilesIndex(target.serverId, target.shareId);
		const byPath = new Map(items.map((item) => [item.path, item]));
		this.indexCache.set(target.shareId, { at: now, items: byPath });
		return byPath;
	}

	private cacheItem(target: OutboundTarget, item: ServerSyncItem): void {
		this.indexCache.get(target.shareId)?.items.set(item.path, item);
	}

	private clearBase(target: OutboundTarget): void {
		const current = this.deps.baseStore.get(target.shareId);
		if (!current || !(target.relativePath in current)) return;
		const manifest = { ...current };
		delete manifest[target.relativePath];
		this.deps.baseStore.set(target.shareId, manifest);
	}

	private recordBase(target: OutboundTarget, sha: string): void {
		const manifest = { ...(this.deps.baseStore.get(target.shareId) ?? {}) };
		if (manifest[target.relativePath] === sha) return;
		manifest[target.relativePath] = sha;
		this.deps.baseStore.set(target.shareId, manifest);
	}
}
