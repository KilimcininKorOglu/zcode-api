/**
 * Environment-variable readers shared by feature modules.
 *
 * Every duration is a positive millisecond count; absent, non-numeric,
 * non-finite, zero, and negative inputs fall back to the caller's default so a
 * bad value can never disable a timeout or a cache TTL.
 */

/** Read a positive millisecond override from `raw`, else `fallback`. */
export function envMs(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
