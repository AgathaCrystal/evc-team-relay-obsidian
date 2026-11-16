/** @jest-environment node */
import path from "node:path";
import type { Component as SvelteComponentType } from "svelte";
import { getLanguage, Platform } from "obsidian";
import type { RelayOnPremServer } from "../src/RelayOnPremConfig";
import { EVC_CP_URL, EVC_SERVER_ID, TR_RU_CP_URL, TR_RU_SERVER_ID } from "../src/RelayOnPremConfig";
import { ServerInfoCache } from "../src/serverInfoCache";
import { loadSvelteComponent } from "../scripts/test/svelteDOM.cjs";
import { testGlobal } from "./mocks/testGlobal";

// The server list is rendered from its real source. Only the network
// boundary (platformFetch) and the Obsidian host are replaced. The
// /v1/server/info answer is held back to reproduce a slow control plane: the
// buttons a user sees on first paint must stay where they are once it arrives.

const fetch = jest.fn();
let Component: SvelteComponentType<Record<string, unknown>>;
let mountComponent: typeof import("../src/svelteMount").mountComponent;
let component: ReturnType<typeof mountComponent> | undefined;
let closeDom: () => void;

beforeAll(async () => {
	const loaded = loadSvelteComponent(path.resolve(__dirname, "../src/components/RelayOnPremServerList.svelte"), {
		obsidian: { Notice: jest.fn(), Platform },
		"../platformFetch": { platformFetch: fetch },
		"../RelayOnPremConfig": await import("../src/RelayOnPremConfig"),
		"../wording/uiText": await import("../src/wording/uiText"),
		"../auth/OAuthCancelledError": await import("../src/auth/OAuthCancelledError"),
		"../inFlightGuard": await import("../src/inFlightGuard"),
		"../ui/RelayOnPremLoginModal": {},
		"../ui/dialogs": {},
		"../assets/evc-logo.png": "",
	});
	closeDom = () => loaded.dom.window.close();
	Object.assign(testGlobal, { window: loaded.dom.window, document: loaded.dom.window.document,
		activeDocument: loaded.dom.window.document, Event: loaded.dom.window.Event });
	Component = loaded.default;
	mountComponent = loaded.mountComponent;
});
afterAll(() => closeDom?.());

async function flush() {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

const ENTIRE: RelayOnPremServer = { id: EVC_SERVER_ID, name: "Entire VC", controlPlaneUrl: EVC_CP_URL, isValidated: true };
const RU: RelayOnPremServer = { id: TR_RU_SERVER_ID, name: "Team Relay RU", controlPlaneUrl: TR_RU_CP_URL, isValidated: true };
const BILLING_INFO = { id: "x", name: "x", version: "1.0.0", relay_url: "", edition: "enterprise",
	features: { billing_enabled: true }, branding: { logo_url: "https://cp.example/logo.png" } };
const COMMUNITY_INFO = { id: "x", name: "x", version: "1.0.0", relay_url: "", edition: "community", features: {} };

type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };
let heldInfo: Array<{ url: string; answer: (body: unknown) => void; fail: () => void }>;

function serverInfoCalls(): string[] {
	return fetch.mock.calls.map(([url]) => url as string).filter((url) => url.endsWith("/v1/server/info"));
}

function mount(servers: RelayOnPremServer[], cache: ServerInfoCache, loggedIn: (id: string) => boolean = () => true) {
	const settings = { servers, defaultServerId: "" };
	const subscribe = (run: (value: typeof settings) => void) => {
		run(settings);
		return () => undefined;
	};
	component = mountComponent(Component, { target: document.body, props: {
		live: {
			relayOnPremSettings: { subscribe, mutateValue: jest.fn() },
			authSession: { isLoggedInToServer: loggedIn },
			serverInfoCache: cache,
		},
	} });
}

/** Answer every /v1/server/info request, including ones started after an earlier answer. */
async function answerAll(body: unknown) {
	let answered = 0;
	while (answered < heldInfo.length) {
		heldInfo[answered++].answer(body);
		await flush();
	}
}

function unmount() {
	component?.destroy();
	component = undefined;
	document.body.innerHTML = "";
}

function rowButtons(row: number): HTMLButtonElement[] {
	const item = document.querySelectorAll(".relay-server-item")[row];
	return [...item.querySelectorAll<HTMLButtonElement>(".relay-server-actions button")];
}

function labels(row: number): string[] {
	return rowButtons(row).map((button) => button.textContent!.trim());
}

beforeEach(() => {
	(getLanguage as jest.Mock).mockReturnValue("ru");
	heldInfo = [];
	fetch.mockReset();
	fetch.mockImplementation((url: string) => new Promise<Answer>((resolve, reject) => {
		heldInfo.push({
			url,
			answer: (body) => resolve({ ok: true, status: 200, json: async () => body }),
			fail: () => reject(new Error("net::ERR_TIMED_OUT")),
		});
	}));
});
afterEach(unmount);

describe("server list keeps its buttons in place while /v1/server/info is slow", () => {
	test("RU row: the buttons and their order are the same before and after the answer", async () => {
		mount([ENTIRE, RU], new ServerInfoCache());
		await flush();
		const before = labels(1);
		const sharesBefore = rowButtons(1).findIndex((b) => b.textContent!.trim() === "Общие доступы");
		// The button that sits at a measured point before the answer (the one after Shares).
		const atPointBefore = rowButtons(1)[sharesBefore + 1];

		await answerAll(BILLING_INFO);

		expect(labels(1)).toEqual(before);
		expect(rowButtons(1)[sharesBefore + 1]).toBe(atPointBefore);
		expect(labels(1)).toContain("Тариф и использование");
		expect(labels(0)).toContain("Тариф и использование");
	});

	test("Plan & Usage is on the row from the first paint, disabled until the server answers", async () => {
		mount([ENTIRE], new ServerInfoCache());
		await flush();
		const plan = () => rowButtons(0).find((b) => b.textContent!.trim() === "Тариф и использование");
		expect(plan()).toBeDefined();
		expect(plan()!.disabled).toBe(true);
		heldInfo[0].answer(BILLING_INFO);
		await flush();
		expect(plan()!.disabled).toBe(false);
	});

	test("coming back to the list does not ask the server again and draws the final row at once", async () => {
		const cache = new ServerInfoCache();
		mount([ENTIRE, RU], cache);
		await flush();
		await answerAll(BILLING_INFO);
		const settled = [labels(0), labels(1)];
		expect(serverInfoCalls()).toHaveLength(2);
		unmount();

		mount([ENTIRE, RU], cache);
		// First synchronous paint, before any promise settles.
		expect([labels(0), labels(1)]).toEqual(settled);
		expect(rowButtons(1).find((b) => b.textContent!.trim() === "Тариф и использование")!.disabled).toBe(false);
		await flush();
		expect(serverInfoCalls()).toHaveLength(2);
	});

	test("servers are asked in parallel, not one after another", async () => {
		mount([ENTIRE, RU], new ServerInfoCache());
		await flush();
		expect(serverInfoCalls().sort()).toEqual([`${EVC_CP_URL}/v1/server/info`, `${TR_RU_CP_URL}/v1/server/info`].sort());
	});

	test.each([
		["no billing", (held: { answer: (body: unknown) => void }) => held.answer(COMMUNITY_INFO)],
		["request failed", (held: { fail: () => void }) => held.fail()],
	])("%s: both rows keep the same buttons, in the same order, before and after the answer", async (_case, settle) => {
		mount([ENTIRE, RU], new ServerInfoCache());
		await flush();
		const before = [rowButtons(0), rowButtons(1)];
		const beforeLabels = [labels(0), labels(1)];
		// Settle every request, including ones started after an earlier answer.
		for (let i = 0; i < heldInfo.length; i++) {
			settle(heldInfo[i] as never);
			await flush();
		}
		expect(heldInfo).toHaveLength(2);
		expect([labels(0), labels(1)]).toEqual(beforeLabels);
		expect([rowButtons(0), rowButtons(1)]).toEqual(before);
		for (const row of [0, 1]) {
			for (const [i, button] of rowButtons(row).entries()) expect(button).toBe(before[row][i]);
			const plan = rowButtons(row).find((b) => b.textContent!.trim() === "Тариф и использование")!;
			expect(plan.disabled).toBe(true);
		}
	});

	test("no billing: the kept slot is invisible and inert; next time the row is drawn without it", async () => {
		const cache = new ServerInfoCache();
		mount([ENTIRE], cache);
		await flush();
		heldInfo[0].answer(COMMUNITY_INFO);
		await flush();
		const plan = rowButtons(0).find((b) => b.textContent!.trim() === "Тариф и использование")!;
		expect(plan.classList.contains("relay-server-btn-reserved")).toBe(true);
		expect(plan.getAttribute("aria-hidden")).toBe("true");
		expect(plan.tabIndex).toBe(-1);
		expect(plan.disabled).toBe(true);
		unmount();

		mount([ENTIRE], cache);
		const firstPaint = labels(0);
		expect(firstPaint).not.toContain("Тариф и использование");
		await flush();
		expect(labels(0)).toEqual(firstPaint);
		expect(serverInfoCalls()).toHaveLength(1);
	});

	test("request failed: the next opening keeps the slot (disabled) and asks again", async () => {
		const cache = new ServerInfoCache();
		mount([RU], cache);
		await flush();
		heldInfo[0].fail();
		await flush();
		unmount();

		mount([RU], cache);
		const firstPaint = labels(0);
		expect(firstPaint).toContain("Тариф и использование");
		await flush();
		expect(serverInfoCalls()).toHaveLength(2);
		heldInfo[1].answer(BILLING_INFO);
		await flush();
		expect(labels(0)).toEqual(firstPaint);
		expect(rowButtons(0).find((b) => b.textContent!.trim() === "Тариф и использование")!.disabled).toBe(false);
	});

	test("logged-out server keeps Shares, Plan & Usage and Agent Keys disabled with the login hint", async () => {
		const cache = new ServerInfoCache();
		cache.remember(RU, BILLING_INFO);
		mount([RU], cache, () => false);
		await answerAll(BILLING_INFO);
		for (const label of ["Общие доступы", "Тариф и использование", "Ключи агента"]) {
			const button = rowButtons(0).find((b) => b.textContent!.trim() === label)!;
			expect(button.disabled).toBe(true);
			expect(button.title).toBe("Войдите, чтобы управлять");
		}
	});
});
