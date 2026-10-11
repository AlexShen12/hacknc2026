import { z } from "zod";

/** Catalog and pickup choices a parsed need may refer to. */
export interface ParseContext {
  offers: {
    key: string;
    productFamily: string;
    retailer: string;
    retailerLabel: string;
    productName: string;
    unit: string;
    packageQuantity: number;
    membershipRequired: string | null;
  }[];
  windows: { key: string; label: string; startsAt: string }[];
}

/** A suggestion for the need form. The shopper always reviews it before submitting. */
export interface NeedDraft {
  offerKey: string | null;
  quantity: number | null;
  maxContributionCents: number | null;
  pickupWindow: string | null;
}

export const MAX_NEED_TEXT = 300;

const modelSchema = z.object({
  offerKey: z.string().nullish(),
  quantity: z.number().nullish(),
  maxDollars: z.number().nullish(),
  pickupWindow: z.string().nullish(),
});

/**
 * Validate untrusted parser output (model or local) against the session's catalog. Anything not
 * recognized becomes null; amounts and quantities must be sane whole values.
 */
export function validateNeedDraft(raw: unknown, context: ParseContext): NeedDraft {
  let value = raw;
  if (typeof raw === "string") {
    const match = raw.match(/\{[\s\S]*\}/);
    try {
      value = match ? JSON.parse(match[0]) : null;
    } catch {
      value = null;
    }
  }
  const parsed = modelSchema.safeParse(value);
  if (!parsed.success) {
    return { offerKey: null, quantity: null, maxContributionCents: null, pickupWindow: null };
  }
  const offer = context.offers.find((item) => item.key === parsed.data.offerKey);
  const quantity = parsed.data.quantity;
  const validQuantity =
    quantity != null &&
    Number.isSafeInteger(quantity) &&
    quantity > 0 &&
    (!offer || quantity < offer.packageQuantity)
      ? quantity
      : null;
  const dollars = parsed.data.maxDollars;
  const cents =
    dollars != null && Number.isFinite(dollars) && dollars > 0 && dollars < 100_000
      ? Math.round(dollars * 100)
      : null;
  const window = context.windows.find((item) => item.key === parsed.data.pickupWindow);
  return {
    offerKey: offer?.key ?? null,
    quantity: validQuantity,
    maxContributionCents: cents,
    pickupWindow: window?.key ?? null,
  };
}

const FAMILY_WORDS: [RegExp, string][] = [
  [/paper\s*towel|towels?\b/i, "paper-towels"],
  [/snack|granola|protein\s*bar|\bbars?\b/i, "snack-bars"],
  [/trash|garbage|bin\s*bags?|\bbags?\b/i, "trash-bags"],
];

const RETAILER_WORDS: [RegExp, string][] = [
  [/walmart/i, "walmart"],
  [/costco/i, "costco"],
  [/sam'?s(\s*club)?/i, "sams_club"],
];

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * Deterministic parser: product and retailer keywords, a quantity, a dollar limit and a weekday.
 * Its output is validated by `validateNeedDraft` like any untrusted input.
 */
export function localParseNeed(text: string, context: ParseContext) {
  const input = text.slice(0, MAX_NEED_TEXT);
  const family = FAMILY_WORDS.find(([pattern]) => pattern.test(input))?.[1];
  const retailer = RETAILER_WORDS.find(([pattern]) => pattern.test(input))?.[1];
  const candidates = context.offers
    .filter((offer) => !family || offer.productFamily === family)
    .filter((offer) => !retailer || offer.retailer === retailer)
    .sort((a, b) => Number(a.membershipRequired !== null) - Number(b.membershipRequired !== null));
  const offer = family || retailer ? candidates[0] : undefined;

  const money =
    input.match(/\$\s*(\d+(?:\.\d{1,2})?)/) ??
    input.match(/(\d+(?:\.\d{1,2})?)\s*(?:dollars|bucks|usd)\b/i) ??
    input.match(/(?:under|up to|max(?:imum)?|at most|no more than)\s*(\d+(?:\.\d{1,2})?)/i);
  const withoutMoney = money ? input.replace(money[0], " ") : input;
  const quantityMatch =
    withoutMoney.match(/(\d{1,3})\s*(?:rolls?|bars?|bags?|units?|count|ct|pack)/i) ??
    withoutMoney.match(/\b(\d{1,3})\b/);

  const lower = input.toLowerCase();
  const day = WEEKDAYS.find((weekday) => new RegExp(`\\b${weekday}`, "i").test(lower));
  const window = day
    ? context.windows.find((item) => item.label.toLowerCase().startsWith(day))
    : /\b(soonest|earliest|first|tomorrow)\b/.test(lower)
      ? [...context.windows].sort((a, b) => (a.startsAt < b.startsAt ? -1 : 1))[0]
      : undefined;

  return {
    offerKey: offer?.key ?? null,
    quantity: quantityMatch ? Number(quantityMatch[1]) : null,
    maxDollars: money ? Number(money[1]) : null,
    pickupWindow: window?.key ?? null,
  };
}
