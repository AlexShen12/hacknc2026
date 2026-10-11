import type { ComparisonBaseline } from "@/domain/types";

/** Comparison price for buying `quantity` alone, and whether it was estimated. */
export interface BaselineEstimate {
  baselineCents: number;
  estimated: boolean;
  /** Known quantities the price came from. */
  basis: number[];
}

/** Round a nonnegative ratio half up using integer arithmetic. */
function roundDiv(numerator: bigint, denominator: bigint): number {
  return Number((2n * numerator + denominator) / (2n * denominator));
}

/**
 * Exact fixture price when the quantity is known. Otherwise estimate from the closest known
 * prices of the same offer: interpolate between the two neighbors, or scale the nearest endpoint's
 * per-unit price outside the known range. Returns null when the offer has no prices at all.
 */
export function estimateBaseline(
  baselines: readonly ComparisonBaseline[],
  quantity: number,
): BaselineEstimate | null {
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || baselines.length === 0) return null;
  const sorted = [...baselines].sort((a, b) => a.quantity - b.quantity);
  const exact = sorted.find((item) => item.quantity === quantity);
  if (exact) return { baselineCents: exact.baselineCents, estimated: false, basis: [quantity] };

  const lower = sorted.filter((item) => item.quantity < quantity).at(-1);
  const upper = sorted.find((item) => item.quantity > quantity);
  if (lower && upper) {
    const span = BigInt(upper.quantity - lower.quantity);
    const weighted =
      BigInt(lower.baselineCents) * BigInt(upper.quantity - quantity) +
      BigInt(upper.baselineCents) * BigInt(quantity - lower.quantity);
    return {
      baselineCents: roundDiv(weighted, span),
      estimated: true,
      basis: [lower.quantity, upper.quantity],
    };
  }
  const nearest = lower ?? upper;
  if (!nearest) return null;
  return {
    baselineCents: roundDiv(
      BigInt(nearest.baselineCents) * BigInt(quantity),
      BigInt(nearest.quantity),
    ),
    estimated: true,
    basis: [nearest.quantity],
  };
}
