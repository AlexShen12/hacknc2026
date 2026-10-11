import { describe, expect, it } from "vitest";
import { estimateBaseline } from "@/domain/baseline";

const known = [
  { quantity: 12, baselineCents: 4300 },
  { quantity: 4, baselineCents: 1500 },
  { quantity: 8, baselineCents: 2900 },
  { quantity: 6, baselineCents: 2200 },
];

describe("estimateBaseline", () => {
  it("returns the known price exactly", () => {
    expect(estimateBaseline(known, 6)).toEqual({
      baselineCents: 2200,
      estimated: false,
      basis: [6],
    });
  });

  it("interpolates between the two closest known quantities", () => {
    expect(estimateBaseline(known, 5)).toEqual({
      baselineCents: 1850,
      estimated: true,
      basis: [4, 6],
    });
    expect(estimateBaseline(known, 10)).toEqual({
      baselineCents: 3600,
      estimated: true,
      basis: [8, 12],
    });
    expect(estimateBaseline(known, 7)?.baselineCents).toBe(2550);
  });

  it("scales the nearest per-unit price outside the known range", () => {
    expect(estimateBaseline(known, 2)).toEqual({ baselineCents: 750, estimated: true, basis: [4] });
    expect(estimateBaseline(known, 18)).toEqual({
      baselineCents: 6450,
      estimated: true,
      basis: [12],
    });
    expect(estimateBaseline([{ quantity: 3, baselineCents: 1000 }], 1)?.baselineCents).toBe(333);
    expect(estimateBaseline([{ quantity: 3, baselineCents: 1000 }], 2)?.baselineCents).toBe(667);
  });

  it("has no estimate without known prices or for invalid quantities", () => {
    expect(estimateBaseline([], 5)).toBeNull();
    expect(estimateBaseline(known, 0)).toBeNull();
    expect(estimateBaseline(known, 2.5)).toBeNull();
  });
});
