import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-savings text-white hover:bg-savings-strong disabled:bg-savings/50",
  secondary: "border border-line bg-surface text-ink hover:bg-sunken disabled:text-muted",
  ghost: "text-ink hover:bg-sunken disabled:text-muted",
  danger:
    "border border-danger/30 bg-danger-soft text-danger hover:bg-danger/10 disabled:opacity-60",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed",
        size === "sm" ? "px-3 py-1.5 text-sm" : "px-4 py-2.5 text-[15px]",
        VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}
