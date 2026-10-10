import { DomainError } from "@/domain/errors";

const DOLLARS_PATTERN = /^\s*\$?\s*(\d{1,7})(?:\.(\d{1,2}))?\s*$/;

/** Parse user-entered dollars ("15", "15.5", "$15.50") as text into integer cents. */
export function parseDollarsToCents(input: string): number {
  const match = DOLLARS_PATTERN.exec(input);
  if (!match) {
    throw new DomainError(
      "INVALID_AMOUNT",
      "Enter a dollar amount with at most two decimal places.",
    );
  }
  const whole = Number(match[1]);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  return whole * 100 + Number(fraction);
}

export function assertCents(value: number, label = "amount"): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      "INVALID_AMOUNT",
      `${label} must be a nonnegative whole number of cents.`,
    );
  }
  return value;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Display only. Never feed the result back into calculations. */
export function formatCents(cents: number): string {
  return usd.format(cents / 100);
}

export interface QuantityShare {
  id: string;
  quantity: number;
}

/**
 * Split totalCents in proportion to quantity using largest-remainder allocation.
 * Residual cents go to the largest remainders, ties broken by ascending id.
 * The result always sums exactly to totalCents.
 */
export function allocateByQuantity(
  totalCents: number,
  shares: QuantityShare[],
): Map<string, number> {
  assertCents(totalCents, "totalCents");
  if (shares.length === 0) {
    throw new DomainError("INVALID_ALLOCATION", "At least one share is required.");
  }
  let totalQuantity = 0n;
  for (const share of shares) {
    if (!Number.isSafeInteger(share.quantity) || share.quantity <= 0) {
      throw new DomainError("INVALID_ALLOCATION", "Quantities must be positive integers.");
    }
    totalQuantity += BigInt(share.quantity);
  }

  const total = BigInt(totalCents);
  const parts = shares.map((share) => {
    const numerator = total * BigInt(share.quantity);
    return {
      id: share.id,
      floor: numerator / totalQuantity,
      remainder: numerator % totalQuantity,
    };
  });

  let residual = total - parts.reduce((sum, part) => sum + part.floor, 0n);
  const order = [...parts].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const extra = new Set<string>();
  for (const part of order) {
    if (residual === 0n) break;
    extra.add(part.id);
    residual -= 1n;
  }

  const result = new Map<string, number>();
  for (const part of parts) {
    result.set(part.id, Number(part.floor + (extra.has(part.id) ? 1n : 0n)));
  }
  return result;
}

/** Smallest share any participant with this quantity could be allocated (largest remainder floor). */
export function minimumShareCents(totalCents: number, quantity: number, packageQuantity: number) {
  return Number((BigInt(totalCents) * BigInt(quantity)) / BigInt(packageQuantity));
}
