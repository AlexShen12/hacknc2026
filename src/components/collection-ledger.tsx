"use client";

import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LedgerList } from "@/components/ledger-list";
import { Card, SectionTitle } from "@/components/ui/card";
import { api, REFRESH_EVENT } from "@/lib/api-client";
import type { LedgerEntryView } from "@/lib/view-types";

interface Ledger {
  account: { nickname: string; maskedNumber: string | null } | null;
  entries: LedgerEntryView[];
  verified: number;
  confirmed: number;
  provider: string;
}

/** The group's collection account, re-read from the bank when shown and after actions. */
export function CollectionLedger({ groupId }: { groupId: string }) {
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const load = useCallback(async () => {
    try {
      setLedger(await api<Ledger>(`/api/groups/${groupId}/ledger`));
    } catch {
      // Keep the last result.
    }
  }, [groupId]);

  useEffect(() => {
    void load();
    const listener = () => void load();
    window.addEventListener(REFRESH_EVENT, listener);
    return () => window.removeEventListener(REFRESH_EVENT, listener);
  }, [load]);

  if (!ledger?.account) return null;
  const bankLabel = ledger.provider === "nessie" ? "Nessie" : "ledger";
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <SectionTitle>Collection account</SectionTitle>
        <p className="flex items-center gap-1.5 text-sm text-muted">
          <ShieldCheck size={16} aria-hidden className="text-savings" />
          {ledger.verified} of {ledger.confirmed} confirmed records verified with{" "}
          {ledger.provider === "nessie" ? "Capital One Nessie" : "the simulated ledger"}
        </p>
      </div>
      <p className="text-xs text-muted">
        {ledger.account.nickname}
        {ledger.account.maskedNumber ? ` · ${ledger.account.maskedNumber}` : ""} · holds this
        group&apos;s contributions until the purchase
      </p>
      <LedgerList entries={ledger.entries} bankLabel={bankLabel} />
    </Card>
  );
}
