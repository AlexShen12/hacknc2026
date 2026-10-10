"use client";

import { UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { announceRefresh, api } from "@/lib/api-client";
import type { SessionView } from "@/lib/view-types";

export function PersonaSwitcher({ session }: { session: SessionView }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function choose(shopperId: string) {
    setPending(true);
    try {
      await api("/api/demo/persona", { body: { shopperId } });
      router.refresh();
      announceRefresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <UserRound size={18} aria-hidden className="text-muted" />
      <span className="sr-only sm:not-sr-only text-muted">Shopping as</span>
      <select
        className="rounded-lg border border-line bg-surface px-2 py-1.5 font-semibold"
        value={session.selectedShopperId ?? ""}
        disabled={pending}
        onChange={(event) => choose(event.target.value)}
        aria-label="Choose demo shopper"
      >
        {session.shoppers.map((shopper) => (
          <option key={shopper.id} value={shopper.id}>
            {shopper.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}
