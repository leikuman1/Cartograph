"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useRef, useState } from "react";
import { readProgressSnapshot } from "@/app/(workspace)/actions";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import { applyProgress, isProgressMessage, type AnalysisSummary } from "@/lib/pipeline/types";

interface ProgressConnection {
  summaries: Map<string, AnalysisSummary>;
  error: string | null;
  connected: boolean;
}

export function useAnalysisProgress(organizationId: string, analyses: readonly AnalysisSummary[]) {
  const { getToken } = useAuth();
  const [connection, setConnection] = useState<ProgressConnection>(() => ({
    summaries: new Map(analyses.map(analysis => [analysis.id, analysis])),
    error: null,
    connected: false,
  }));
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const ids = analyses.map(analysis => analysis.id).join(",");

  useEffect(() => {
    // A server refresh also supplies commit and result metadata. Preserve a
    // socket update only when it is newer than that server snapshot.
    setConnection(current => ({
      ...current,
      summaries: new Map(analyses.map(analysis => {
        const live = current.summaries.get(analysis.id);
        return [analysis.id, live && Date.parse(live.updated_at) > Date.parse(analysis.updated_at) ? live : analysis];
      })),
    }));
  }, [analyses]);

  useEffect(() => {
    if (!ids) return;
    const client = createBrowserSupabaseClient(() => getTokenRef.current());
    let cancelled = false;
    const analysisIds = ids.split(",");
    const subscribed = new Set<string>();
    const channels: ReturnType<typeof client.channel>[] = [];
    let snapshotInFlight = false;

    async function reconcile() {
      // One read after all channels join/rejoin closes the gap between the
      // server snapshot and subscription. Stage events never cause reads.
      if (snapshotInFlight) return;
      snapshotInFlight = true;
      try {
        const rows = await readProgressSnapshot(organizationId, analysisIds);
        if (cancelled) return;
        setConnection(current => {
          const summaries = new Map(current.summaries);
          for (const row of rows) {
            const existing = summaries.get(row.id);
            if (existing && Date.parse(row.updated_at) < Date.parse(existing.updated_at)) continue;
            summaries.set(row.id, row);
          }
          return { ...current, summaries };
        });
      } catch {
        if (!cancelled) setConnection(current => ({
          ...current,
          error: "The progress snapshot could not be refreshed. Reload this page to recover missed stages.",
        }));
      } finally {
        snapshotInFlight = false;
      }
    }

    async function connect() {
      try {
        await client.realtime.setAuth();
        if (cancelled) return;
        for (const analysisId of analysisIds) {
          const channel = client.channel(`analysis:${analysisId}:progress`, { config: { private: true } })
            .on("broadcast", { event: "progress" }, ({ payload }: { payload: unknown }) => {
              if (cancelled || !isProgressMessage(payload) || payload.analysisId !== analysisId) return;
              setConnection(current => {
                const summary = current.summaries.get(analysisId);
                if (!summary) return current;
                const next = applyProgress(summary, payload);
                if (next === summary) return current;
                const summaries = new Map(current.summaries);
                summaries.set(analysisId, next);
                return { ...current, summaries };
              });
            })
            .subscribe(status => {
              if (cancelled) return;
              if (status === "SUBSCRIBED") {
                subscribed.add(analysisId);
                setConnection(current => ({
                  ...current,
                  connected: subscribed.size === analysisIds.length,
                  error: subscribed.size === analysisIds.length ? null : current.error,
                }));
                if (subscribed.size === analysisIds.length) void reconcile();
              } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
                subscribed.delete(analysisId);
                setConnection(current => ({
                  ...current,
                  connected: false,
                  error: "Live progress is disconnected. The stages below may be out of date.",
                }));
              }
            });
          channels.push(channel);
        }
      } catch (error) {
        if (cancelled) return;
        setConnection(current => ({
          ...current,
          connected: false,
          error: error instanceof Error ? error.message : "Live progress is unavailable.",
        }));
      }
    }

    void connect();
    return () => {
      cancelled = true;
      for (const channel of channels) void client.removeChannel(channel);
      client.realtime.disconnect();
    };
  }, [ids, organizationId]);

  return connection;
}
