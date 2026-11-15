import type { AvailablePlan } from "../RelayOnPremShareClient";
import type { PhraseKey } from "../wording/phrasebook";
import { isOpenableUrl } from "./openableUrl";

export interface LegalLink {
	labelKey: PhraseKey;
	url: string;
}

/**
 * Team Relay RU legal documents a buyer must be able to reach from the
 * payment buttons. Both pages are on teamrelay.ru, the operator's
 * own site.
 */
const RU_LEGAL_LINKS: readonly LegalLink[] = [
	{ labelKey: "billing.legal.offerLink", url: "https://teamrelay.ru/offer/" },
	{ labelKey: "billing.legal.refundLink", url: "https://teamrelay.ru/refund/" },
];

/**
 * The offer/refund row is shown only when the plans are priced in roubles,
 * i.e. on the Russian deployment. The Entire deployment (USD) has its own
 * terms and gets no row. Every URL still passes `isOpenableUrl` so nothing
 * but http(s) can reach `window.open`.
 */
export function legalLinksFor(plans: readonly AvailablePlan[]): LegalLink[] {
	const pricedInRub = plans.some((p) =>
		(p.prices || []).some((price) => (price.currency || "").trim().toUpperCase() === "RUB"),
	);
	if (!pricedInRub) return [];
	return RU_LEGAL_LINKS.filter((l) => isOpenableUrl(l.url));
}
