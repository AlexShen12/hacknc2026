"use client";

import { FlaskConical, Landmark } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";

export function StartDemo({
  sponsorConfigured,
  label = "Start the demo",
}: {
  sponsorConfigured: boolean;
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"rehearsal" | "sponsor" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function start(mode: "rehearsal" | "sponsor") {
    setBusy(mode);
    setError(null);
    try {
      await api("/api/demo/sessions", { body: { mode } });
      router.push("/shop");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a session.");
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => start("rehearsal")} disabled={busy !== null}>
          <FlaskConical size={18} aria-hidden />
          {busy === "rehearsal" ? "Setting up…" : `${label} (rehearsal)`}
        </Button>
        <Button
          variant="secondary"
          onClick={() => start("sponsor")}
          disabled={busy !== null || !sponsorConfigured}
          title={
            sponsorConfigured ? undefined : "Sponsor credentials are not configured on this server"
          }
        >
          <Landmark size={18} aria-hidden />
          {busy === "sponsor" ? "Creating sandbox accounts…" : "Live mode (Capital One Nessie)"}
        </Button>
      </div>
      {!sponsorConfigured ? (
        <p className="text-sm text-muted">
          Live mode is unavailable here because Nessie credentials are not configured.
          Rehearsal mode uses a local simulated bank ledger and local analytics.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
