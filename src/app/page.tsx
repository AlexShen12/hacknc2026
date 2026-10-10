import { HandCoins, PackageOpen, Users } from "lucide-react";
import Link from "next/link";
import { PersonaPicker } from "@/components/persona-picker";
import { StartDemo } from "@/components/start-demo";
import { Card } from "@/components/ui/card";
import { isSponsorConfigured } from "@/server/config";
import { getPageSession } from "@/server/page-session";

export default async function HomePage() {
  const current = await getPageSession();
  const sponsorConfigured = isSponsorConfigured();

  return (
    <div className="flex flex-col gap-10">
      <section className="grid gap-6 md:grid-cols-[1.4fr_1fr] md:items-center">
        <div className="flex flex-col gap-5">
          <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl">
            Bulk savings, <span className="text-savings">without buying the whole bulk.</span>
          </h1>
          <p className="text-lg text-muted">
            Get the savings of buying together without needing the whole package or fronting
            everyone else&apos;s money. Tell us how much you need and what you can spend; we find
            neighbors who need the rest.
          </p>
          {current ? (
            <div className="flex flex-wrap items-center gap-3">
              <Link
                href="/shop"
                className="rounded-xl bg-savings px-4 py-2.5 font-semibold text-white hover:bg-savings-strong"
              >
                Continue shopping
              </Link>
              <StartDemo sponsorConfigured={sponsorConfigured} label="Start over" />
            </div>
          ) : (
            <StartDemo sponsorConfigured={sponsorConfigured} />
          )}
        </div>
        <Card className="flex flex-col gap-4 bg-savings-soft/60">
          {[
            {
              Icon: PackageOpen,
              title: "Useful shares",
              text: "Only the quantity you will actually use.",
            },
            {
              Icon: HandCoins,
              title: "Your budget, respected",
              text: "Every share stays within your limit.",
            },
            {
              Icon: Users,
              title: "Disruptions handled",
              text: "If someone leaves, their money goes back first.",
            },
          ].map(({ Icon, title, text }) => (
            <div key={title} className="flex gap-3">
              <Icon className="mt-0.5 shrink-0 text-savings" size={22} aria-hidden />
              <div>
                <p className="font-bold">{title}</p>
                <p className="text-sm text-muted">{text}</p>
              </div>
            </div>
          ))}
        </Card>
      </section>
      {current ? <PersonaPicker session={current.view} /> : null}
    </div>
  );
}
