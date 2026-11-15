import type { AvailablePlan, BillingPlanResponse } from "../RelayOnPremShareClient";

/**
 * Decide which of the offered plans is the one the account is actually on.
 *
 * Resolved ONCE against the whole list rather than per card. The earlier
 * per-card version asked each card "am I the free one?" by looking at its own
 * prices; on a deployment where the paid plan carries no non-zero price both
 * cards answered yes and both rendered the "Current" badge.
 *
 * Two current plans is worse than none: it asserts something that cannot be
 * true and hides which plan actually bills the user. So every ambiguous case
 * returns null - the UI then shows the badge on nothing, which is honest.
 */
export function resolveCurrentPlanId(
	data: Pick<BillingPlanResponse, "plan"> | null,
	plans: readonly AvailablePlan[],
): string | null {
	if (!data || plans.length === 0) return null;

	const declared = (data.plan || "").trim().toLowerCase();
	if (declared === "") return null; // server named no plan - claim nothing

	// Match by plan CODE first. Team Relay RU answers
	// /billing/plan with a code ("free") while its cards carry localized names
	// ("Свободный"), so a name-only match found nothing and no card showed
	// "Current". A code matches an id exactly or as its last `_`-separated
	// segment(s): "free" -> "prod_relay_ru_free". Exactly one hit wins; zero or
	// several fall through to the name match below, which still resolves the
	// Entire deployment's "Relay Builder" -> prod_relay_pro.
	const byCode = plans.filter((p) => {
		const id = typeof p.id === "string" ? p.id.trim().toLowerCase() : "";
		return id !== "" && (id === declared || id.endsWith("_" + declared));
	});
	if (byCode.length === 1) return byCode[0].id || null;

	const named = (p: AvailablePlan) => (p.name || "").trim().toLowerCase();

	// `.id` is typed `string` (required) on AvailablePlan, but that's a
	// compile-time promise about the client's own type, not a guarantee
	// about what the server actually sent over the wire. A server whose
	// /plans response uses a different field name (e.g. `product_id`
	// instead of `id`) still satisfies the cast in
	// getAvailablePlans() and leaves `.id` `undefined` at runtime -- and
	// `undefined` would then compare equal to itself across every plan
	// missing the same field. Never trust a matched plan's `.id` without
	// checking it's actually present.
	const exact = plans.filter((p) => named(p) === declared);
	if (exact.length === 1) return exact[0].id || null;
	if (exact.length > 1) return null; // duplicate names - cannot disambiguate

	const loose = plans.filter((p) => {
		const n = named(p);
		return n !== "" && (n.includes(declared) || declared.includes(n));
	});
	return loose.length === 1 ? loose[0].id || null : null;
}
