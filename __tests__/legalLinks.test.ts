import { legalLinksFor } from "../src/billing/legalLinks";
import type { AvailablePlan } from "../src/RelayOnPremShareClient";

const plan = (id: string, amount: number, currency: string): AvailablePlan => ({
	id,
	name: id,
	service_id: "relay",
	type: "subscription",
	status: "active",
	prices: [{ id: `${id}-m`, amount, currency, billing_period: "month" }],
	entitlements: {},
	metadata: {},
});

// The offer and refund documents sit next to the payment buttons
// on the RU (RUB) screen and nowhere else.
describe("legalLinksFor", () => {
	it("returns the offer and refund pages when plans are priced in RUB", () => {
		const links = legalLinksFor([plan("prod_relay_ru_free", 0, "RUB"), plan("prod_relay_ru_team", 1990, "rub")]);
		expect(links.map((l) => [l.labelKey, l.url])).toEqual([
			["billing.legal.offerLink", "https://teamrelay.ru/offer/"],
			["billing.legal.refundLink", "https://teamrelay.ru/refund/"],
		]);
	});

	it("returns nothing on the USD (Entire) screen", () => {
		expect(legalLinksFor([plan("prod_relay_free", 0, "USD"), plan("prod_relay_pro", 900, "USD")])).toEqual([]);
	});

	it("returns nothing when there are no plans or no prices", () => {
		expect(legalLinksFor([])).toEqual([]);
		expect(legalLinksFor([{ ...plan("x", 0, "RUB"), prices: [] }])).toEqual([]);
	});
});
