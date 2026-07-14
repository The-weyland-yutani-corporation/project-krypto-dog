"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const DEFAULT_REFRESH_MS = 30_000;

/**
 * Re-render the surrounding server component every `intervalMs` by calling
 * `router.refresh()`. Keeps the data flow in server components and avoids
 * adding a parallel client-side fetcher.
 *
 * Tunable via the `NEXT_PUBLIC_ADMIN_REFRESH_MS` env var; falls back to 30s.
 */
export function AutoRefresh({ intervalMs }: { intervalMs?: number }) {
  const router = useRouter();
  const tunable = Number(process.env.NEXT_PUBLIC_ADMIN_REFRESH_MS);
  const ms =
    intervalMs ??
    (Number.isFinite(tunable) && tunable > 0 ? tunable : DEFAULT_REFRESH_MS);

  useEffect(() => {
    const handle = setInterval(() => {
      router.refresh();
    }, ms);
    return () => clearInterval(handle);
  }, [router, ms]);

  return null;
}
