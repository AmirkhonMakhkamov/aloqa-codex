"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { adminApi } from "@/lib/api/endpoints";

const GROUP_LABELS: Record<string, string> = {
  system: "System",
  channels: "Channels",
  meetings: "Meetings",
  messaging: "Messaging",
  files: "Files",
  extensions: "Extensions",
};

export default function RolesAdminPage() {
  const { wsId } = useParams<{ wsId: string }>();
  const [catalog, setCatalog] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    adminApi
      .permissions(wsId)
      .then((next) => {
        if (!alive) return;
        setCatalog(next);
        setError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : "failed to load permissions");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [wsId]);

  const groups = useMemo(
    () => Object.entries(catalog).sort(([a], [b]) => a.localeCompare(b)),
    [catalog],
  );

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-6 py-6">
      <div>
        <h2 className="text-base font-semibold text-ink">Role permissions</h2>
        <p className="text-xs text-ink-3">Permission groups used by workspace custom roles.</p>
      </div>

      {error ? (
        <div className="rounded-md border border-rose-900/60 bg-rose-950/40 p-3 text-sm text-rose-200">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="text-sm text-ink-3">Loading permissions...</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {groups.map(([group, permissions]) => (
            <section key={group} className="rounded-lg border border-line bg-app-2 p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink">
                <ShieldCheck className="h-4 w-4 text-accent" />
                {GROUP_LABELS[group] ?? group}
              </div>
              <div className="flex flex-wrap gap-2">
                {permissions.map((permission) => (
                  <span
                    key={permission}
                    className="rounded-md border border-line bg-app px-2 py-1 font-mono text-[11px] text-ink-2"
                  >
                    {permission}
                  </span>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
