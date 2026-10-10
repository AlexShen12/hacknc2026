"use client";

import { RefreshCw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api-client";
import type { ExplanationView } from "@/lib/view-types";

/** Grounded explanation of the calculated proposal. Numbers elsewhere on the page are authoritative. */
export function ExplanationCard({
  groupId,
  initial,
  autoRequest = true,
  analyticsSource,
}: {
  groupId: string;
  initial: ExplanationView | null;
  autoRequest?: boolean;
  analyticsSource: "snowflake" | "local";
}) {
  const [explanation, setExplanation] = useState(initial);
  const [loading, setLoading] = useState(false);
  const requested = useRef(false);

  const request = useCallback(async () => {
    setLoading(true);
    try {
      setExplanation(
        await api<ExplanationView>(`/api/groups/${groupId}/explanation`, { body: {} }),
      );
    } catch {
      setExplanation((current) => (current ? { ...current, status: "unavailable" } : null));
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    if (autoRequest && !initial && !requested.current) {
      requested.current = true;
      void request();
    }
  }, [autoRequest, initial, request]);

  const source =
    analyticsSource === "snowflake" ? "Snowflake Cortex" : "Rehearsal template (no AI call)";
  return (
    <div className="rounded-xl border border-savings/20 bg-savings-soft/60 p-4" aria-live="polite">
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-bold text-savings-strong">
          <Sparkles size={16} aria-hidden /> Why this group works
        </p>
        <span className="text-xs text-muted">{source}</span>
      </div>
      {loading ? (
        <p className="text-sm text-muted">Writing an explanation…</p>
      ) : explanation?.status === "ready" ? (
        <>
          <p className="text-sm leading-relaxed">{explanation.text}</p>
          {explanation.stale ? (
            <p className="mt-2 text-xs text-warn">The group changed since this was written.</p>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted">
          Explanation unavailable. The numbers below are still accurate.
        </p>
      )}
      {!loading && (explanation?.status !== "ready" || explanation.stale) ? (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => void request()}>
          <RefreshCw size={14} aria-hidden /> {explanation ? "Try again" : "Explain"}
        </Button>
      ) : null}
    </div>
  );
}
