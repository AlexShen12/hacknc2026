import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface BarDatum {
  key: string;
  label: ReactNode;
  value: number;
  /** Visible value text beside the bar (direct label). */
  valueLabel: string;
  /** Full sentence for the hover tooltip and screen readers. */
  description: string;
  /** Optional reference mark, e.g. the package size, on the same scale. */
  reference?: number;
}

/**
 * Single-series horizontal bars on one shared scale: thin marks with rounded data ends anchored to
 * the baseline, a 2px gap between bars, direct value labels and a per-bar hover tooltip.
 */
export function BarList({
  data,
  tone,
  caption,
}: {
  data: BarDatum[];
  tone: "savings" | "demand";
  caption: string;
}) {
  const max = Math.max(1, ...data.map((item) => Math.max(item.value, item.reference ?? 0)));
  return (
    <figure className="flex flex-col gap-0.5">
      <figcaption className="sr-only">{caption}</figcaption>
      {data.map((item) => (
        <div
          key={item.key}
          className="group flex flex-col gap-1 rounded-lg px-1 py-1.5 hover:bg-sunken"
          title={item.description}
        >
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{item.label}</span>
            <span className="shrink-0 font-semibold">{item.valueLabel}</span>
          </div>
          <div
            className="relative h-2.5 rounded-sm bg-sunken"
            role="img"
            aria-label={item.description}
          >
            <div
              className={cn(
                "h-full rounded-r",
                tone === "savings" ? "bg-chart-savings" : "bg-chart-demand",
              )}
              style={{ width: `${(item.value / max) * 100}%` }}
            />
            {item.reference !== undefined ? (
              <div
                className="absolute -top-1 h-[18px] w-0.5 bg-ink/70"
                style={{ left: `calc(${(item.reference / max) * 100}% - 1px)` }}
                aria-hidden
              />
            ) : null}
          </div>
        </div>
      ))}
    </figure>
  );
}
