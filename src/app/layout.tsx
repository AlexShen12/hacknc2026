import { ShoppingBasket } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { OperatorPanel } from "@/components/operator-panel";
import { PersonaSwitcher } from "@/components/persona-switcher";
import { Badge } from "@/components/ui/badge";
import { getPageSession } from "@/server/page-session";
import "./globals.css";

export const metadata: Metadata = {
  title: "CommonCart — buy in bulk together",
  description:
    "Get the savings of buying together without needing the whole package or fronting everyone else's money.",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const current = await getPageSession();
  const view = current?.view;
  return (
    <html lang="en">
      <body className="min-h-screen">
        <div className="border-b border-warn/20 bg-warn-soft px-4 py-2 text-center text-sm text-warn">
          <strong>Demo:</strong> fictional retail offers, simulated club memberships and{" "}
          {view?.mode === "sponsor" ? "Capital One Nessie sandbox banking" : "simulated banking"} —
          no real money moves.
        </div>
        <header className="border-b border-line bg-surface/80 backdrop-blur">
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
            <Link
              href="/"
              className="flex items-center gap-2 text-xl font-extrabold tracking-tight"
            >
              <span className="grid size-9 place-items-center rounded-xl bg-savings text-white">
                <ShoppingBasket size={20} aria-hidden />
              </span>
              CommonCart
            </Link>
            {view ? (
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={view.mode === "sponsor" ? "info" : "neutral"}>
                  {view.mode === "sponsor" ? "Sponsor mode" : "Rehearsal mode"}
                </Badge>
                <PersonaSwitcher session={view} />
                <Link href="/shop" className="text-sm font-semibold text-savings hover:underline">
                  My shopping
                </Link>
                {view.demoControlsEnabled ? <OperatorPanel /> : null}
              </div>
            ) : null}
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 pb-10 text-xs text-muted">
          CommonCart hackathon demo · Retailer names identify fictional fixture offers, not real
          prices or partnerships.
        </footer>
      </body>
    </html>
  );
}
