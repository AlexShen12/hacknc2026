import { DomainError } from "@/domain/errors";
import { MAX_NEED_TEXT, type ParseContext, validateNeedDraft } from "@/domain/need-parse";
import { formatPickupWindow, RETAILER_LABELS } from "@/lib/format";
import type { Providers } from "@/server/providers";
import { listOffers } from "@/server/services/need-service";
import type { SessionRow } from "@/server/services/session-service";

export interface ParsedNeedDraft {
  offerId: string | null;
  quantity: number | null;
  /** Dollars as text, ready for the form field. */
  maxContribution: string | null;
  pickupWindow: string | null;
  source: "parser";
}

/**
 * Turn a shopper's own words into a suggested need. Returns a draft only; the shopper reviews the
 * filled form and submits it themselves. Model output is validated against this session's catalog.
 */
export async function parseNeedText(
  providers: Providers,
  session: SessionRow,
  text: string,
): Promise<ParsedNeedDraft> {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NEED_TEXT) {
    throw new DomainError("INVALID_INPUT", `Describe your need in 1–${MAX_NEED_TEXT} characters.`, {
      fields: { text: `Use 1–${MAX_NEED_TEXT} characters.` },
    });
  }
  const offers = await listOffers(session.id);
  const context: ParseContext = {
    offers: offers.map((offer) => ({
      key: offer.offerKey,
      productFamily: offer.productFamily,
      retailer: offer.retailer,
      retailerLabel: RETAILER_LABELS[offer.retailer],
      productName: offer.productName,
      unit: offer.unit,
      packageQuantity: offer.packageQuantity,
      membershipRequired: offer.membershipRequired,
    })),
    windows: session.pickupWindows.map((window) => ({
      key: window.key,
      label: formatPickupWindow(window.startsAt, window.endsAt),
      startsAt: window.startsAt,
    })),
  };
  const response = await providers.analytics.parseNeed({ text: trimmed, context });
  const draft = validateNeedDraft(response.output, context);
  const offer = offers.find((item) => item.offerKey === draft.offerKey);
  return {
    offerId: offer?.id ?? null,
    quantity: draft.quantity,
    maxContribution:
      draft.maxContributionCents === null ? null : (draft.maxContributionCents / 100).toFixed(2),
    pickupWindow:
      draft.pickupWindow && (!offer || offer.pickupWindows.includes(draft.pickupWindow))
        ? draft.pickupWindow
        : null,
    source: "parser",
  };
}
