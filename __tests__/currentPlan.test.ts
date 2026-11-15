import { resolveCurrentPlanId } from "../src/billing/currentPlan";
import type { AvailablePlan } from "../src/RelayOnPremShareClient";

const plan = (id: string, name: string, amount: number): AvailablePlan => ({
	id,
	name,
	service_id: "relay",
	type: "subscription",
	status: "active",
	prices: [{ id: `${id}-m`, amount, currency: "RUB", billing_period: "month" }],
	entitlements: {},
	metadata: {},
});

// The reported defect: on a deployment where the paid plan carries no non-zero
// price, the old per-card logic classified BOTH cards as "the free one" and both
// rendered the Current badge. Whatever else this returns, it must never be true
// for two cards at once.
describe("resolveCurrentPlanId", () => {
	it("never marks two plans as current, even when both are priced at zero", () => {
		const plans = [plan("free", "Relay Free", 0), plan("builder", "Relay Builder", 0)];
		const id = resolveCurrentPlanId({ plan: "Relay Free" }, plans);
		const marked = plans.filter((p) => p.id === id);
		expect(marked.length).toBeLessThanOrEqual(1);
		expect(id).toBe("free");
	});

	it("picks the paid plan when the server names it", () => {
		const plans = [plan("free", "Relay Free", 0), plan("builder", "Relay Builder", 900)];
		expect(resolveCurrentPlanId({ plan: "Relay Builder" }, plans)).toBe("builder");
	});

	it("picks nothing when the server names no plan", () => {
		const plans = [plan("free", "Relay Free", 0), plan("builder", "Relay Builder", 900)];
		expect(resolveCurrentPlanId({ plan: "" }, plans)).toBeNull();
		expect(resolveCurrentPlanId(null, plans)).toBeNull();
	});

	it("picks nothing when ambiguous - none is better than two", () => {
		const plans = [plan("a", "Relay", 0), plan("b", "Relay", 900)];
		expect(resolveCurrentPlanId({ plan: "Relay" }, plans)).toBeNull();
	});

	it("tolerates case and surrounding whitespace in the name", () => {
		const plans = [plan("free", "  Relay Free ", 0), plan("builder", "Relay Builder", 900)];
		expect(resolveCurrentPlanId({ plan: "relay free" }, plans)).toBe("free");
	});

	//: a server whose /plans response uses a different field name
	// for the identifier (e.g. `product_id` instead of `id`) still satisfies
	// the AvailablePlan cast in getAvailablePlans() at compile time -- the
	// mismatch only shows up at runtime, where the matched plan's `.id` is
	// `undefined`. The old code returned that `undefined` unconditionally;
	// BillingView.svelte then compared it against every OTHER plan's equally
	// `undefined` `.id` and marked all of them "Current" at once. A client/
	// server field-name mismatch must degrade to "no current plan", never to
	// "every plan is current".
	it("picks nothing when the matched plan has no id (client/server schema drift)", () => {
		const malformed = [
			{ ...plan("free", "Relay Free", 0), id: undefined as unknown as string },
			{ ...plan("builder", "Relay Builder", 900), id: undefined as unknown as string },
		];
		const id = resolveCurrentPlanId({ plan: "Relay Free" }, malformed);
		expect(id).toBeNull();
		const marked = malformed.filter((p) => p.id === id);
		expect(marked.length).toBe(0);
	});

	// Team Relay RU answers GET /v1/billing/plan with the plan CODE
	// ("free"), while the cards carry localized names ("Свободный"). Matching by
	// name alone found nothing, so no RU card showed the "Current" badge.
	describe("by plan code (RU deployment, live ids)", () => {
		const ruPlans = [
			plan("prod_relay_ru_free", "Свободный", 0),
			plan("prod_relay_ru_personal", "Личный", 490),
			plan("prod_relay_ru_team", "Командный", 1990),
		];

		it("maps plan:'free' to prod_relay_ru_free", () => {
			expect(resolveCurrentPlanId({ plan: "free" }, ruPlans)).toBe("prod_relay_ru_free");
		});

		it("maps plan:'personal' and plan:'team' to their RU products", () => {
			expect(resolveCurrentPlanId({ plan: "personal" }, ruPlans)).toBe("prod_relay_ru_personal");
			expect(resolveCurrentPlanId({ plan: "team" }, ruPlans)).toBe("prod_relay_ru_team");
		});

		it("does not match a code that is only a substring of an id segment", () => {
			// "am" is inside "team" but is not its own "_am" suffix.
			expect(resolveCurrentPlanId({ plan: "am" }, ruPlans)).toBeNull();
		});

		it("returns null when two ids end with the same code", () => {
			const dup = [plan("a_free", "One", 0), plan("b_free", "Two", 0)];
			expect(resolveCurrentPlanId({ plan: "free" }, dup)).toBeNull();
		});
	});

	describe("Entire deployment (live ids) keeps working", () => {
		const entirePlans = [
			plan("prod_relay_free", "Free", 0),
			plan("prod_relay_pro", "Builder", 900),
		];

		it("maps plan:'Free' and plan:'free' to prod_relay_free", () => {
			expect(resolveCurrentPlanId({ plan: "Free" }, entirePlans)).toBe("prod_relay_free");
			expect(resolveCurrentPlanId({ plan: "free" }, entirePlans)).toBe("prod_relay_free");
		});

		it("maps plan:'Relay Builder' to prod_relay_pro by name", () => {
			expect(resolveCurrentPlanId({ plan: "Relay Builder" }, entirePlans)).toBe("prod_relay_pro");
		});
	});
});
