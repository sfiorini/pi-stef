export type Session = "pre" | "intraday" | "post" | "closed";

// NYSE holiday closures, keyed "month-day". v1 hardcodes 2026 only.
// KNOWN LIMITATION: the daemon is always-on into 2027+, so this list MUST be
// refreshed annually or session classification will silently drift (treating
// future holidays as trading days). Add 2027+ entries before Jan 1 each year.
// TODO(future): fetch from a holiday-data source keyed by year. Tracked in Open Items.
const HOLIDAYS_2026 = new Set([
  "1-1", "1-19", "2-16", "4-3", "5-25", "6-19", "7-3", "9-7", "11-26", "12-25",
]);

function etParts(d: Date): { dow: number; month: number; day: number; minutes: number; year: number } {
  // Convert to America/New_York via Intl (handles DST)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "numeric", day: "numeric", year: "numeric",
    hour: "numeric", minute: "numeric", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  const dow = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(wd);
  return { dow, month: get("month"), day: get("day"), minutes: get("hour") * 60 + get("minute"), year: get("year") };
}

export function classifySession(d: Date): Session {
  const { dow, month, day, minutes, year } = etParts(d);
  if (dow === 0 || dow === 6) return "closed";
  // Year-guard: if we're past the last year with known holidays, throw loudly
  // so the annual-refresh regression can't pass silently.
  // Use ET year (not UTC) for consistency with the holiday check.
  // Callers (routes, daemon) wrap in try/catch to handle gracefully.
  if (year > 2026) throw new Error(`session classifier has no holidays for year ${year} — refresh HOLIDAYS list annually`);
  if (HOLIDAYS_2026.has(`${month}-${day}`)) return "closed";
  if (minutes >= 7 * 60 && minutes < 9 * 60 + 30) return "pre";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "intraday";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "post";
  return "closed";
}
