"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, SectionTitle } from "@/components/ui/card";
import { api } from "@/lib/api-client";
import { MEMBERSHIP_LABELS } from "@/lib/format";
import type { SessionView } from "@/lib/view-types";

export function PersonaPicker({ session }: { session: SessionView }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);

  async function choose(shopperId: string) {
    setPending(shopperId);
    await api("/api/demo/persona", { body: { shopperId } }).catch(() => null);
    router.push("/shop");
    router.refresh();
  }

  return (
    <section className="flex flex-col gap-4" aria-labelledby="personas-title">
      <SectionTitle id="personas-title">Choose a demo shopper</SectionTitle>
      {session.provisioningStatus !== "ready" ? (
        <p role="alert" className="text-sm text-danger">
          This session&apos;s mock accounts are not ready ({session.provisioningStatus}).{" "}
          {session.provisioningError ?? ""} Start over to create a new session.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {session.shoppers.map((shopper) => (
          <button
            key={shopper.id}
            type="button"
            onClick={() => choose(shopper.id)}
            disabled={pending !== null}
            className="text-left"
          >
            <Card
              className={
                shopper.id === session.selectedShopperId
                  ? "border-savings ring-2 ring-savings/30"
                  : "hover:border-savings/50"
              }
            >
              <div className="flex items-center justify-between gap-2">
                <p className="text-lg font-bold">{shopper.displayName}</p>
                {shopper.id === session.selectedShopperId ? (
                  <Badge tone="savings">Selected</Badge>
                ) : null}
              </div>
              <p className="text-sm text-muted">{shopper.tagline}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {shopper.memberships.length === 0 ? <Badge>No club membership</Badge> : null}
                {shopper.memberships.map((membership) => (
                  <Badge key={membership} tone="info">
                    {MEMBERSHIP_LABELS[membership]} member (simulated)
                  </Badge>
                ))}
              </div>
            </Card>
          </button>
        ))}
      </div>
    </section>
  );
}
