import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export type Tone = "neutral" | "savings" | "warn" | "danger" | "info";

const TONES: Record<Tone, string> = {
  neutral: "bg-sunken text-muted border-line",
  savings: "bg-savings-soft text-savings-strong border-savings/20",
  warn: "bg-warn-soft text-warn border-warn/20",
  danger: "bg-danger-soft text-danger border-danger/20",
  info: "bg-info-soft text-info border-info/20",
};

export function Badge({
  tone = "neutral",
  icon,
  children,
  className,
}: {
  tone?: Tone;
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-2xl border px-2.5 py-0.5 text-xs font-semibold",
        TONES[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
