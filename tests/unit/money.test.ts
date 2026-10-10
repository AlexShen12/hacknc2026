import { describe, expect, it } from "vitest";
import { allocateByQuantity, formatCents, parseDollarsToCents } from "@/domain/money";

describe("parseDollarsToCents", () => {
  it.each([
    ["20", 2000],
    ["15.5", 1550],
    ["$12.00", 1200],
    ["0.07", 7],
  ])("parses %s as %i cents", (input, cents) => {
    expect(parseDollarsToCents(input)).toBe(cents);
  });

  it.each(["12.345", "-5", "abc", "", "1e3"])("rejects %s", (input) => {
    expect(() => parseDollarsToCents(input)).toThrow(/two decimal places/);
  });
});

describe("allocateByQuantity", () => {
  it("assigns the extra penny by largest remainder then ascending id", () => {
    const shares = allocateByQuantity(1000, [
      { id: "c", quantity: 1 },
      { id: "a", quantity: 1 },
      { id: "b", quantity: 1 },
    ]);
    expect(Object.fromEntries(shares)).toEqual({ a: 334, b: 333, c: 333 });
  });

  it("splits the featured package evenly", () => {
    const shares = allocateByQuantity(
      6000,
      ["a", "b", "c", "d"].map((id) => ({ id, quantity: 6 })),
    );
    expect([...shares.values()]).toEqual([1500, 1500, 1500, 1500]);
  });

  it("conserves the total across uneven quantities", () => {
    for (let total = 0; total < 3000; total += 37) {
      const shares = allocateByQuantity(total, [
        { id: "x", quantity: 7 },
        { id: "y", quantity: 5 },
        { id: "z", quantity: 11 },
      ]);
      expect([...shares.values()].reduce((sum, value) => sum + value, 0)).toBe(total);
    }
  });

  it("handles amounts that would overflow float multiplication", () => {
    const total = Number.MAX_SAFE_INTEGER - 1;
    const shares = allocateByQuantity(total, [
      { id: "a", quantity: 3 },
      { id: "b", quantity: 4 },
    ]);
    expect([...shares.values()].reduce((sum, value) => sum + value, 0)).toBe(total);
  });

  it("rejects non-positive quantities", () => {
    expect(() => allocateByQuantity(100, [{ id: "a", quantity: 0 }])).toThrow();
  });
});

describe("formatCents", () => {
  it("formats for display", () => {
    expect(formatCents(1500)).toBe("$15.00");
  });
});
