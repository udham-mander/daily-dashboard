// Local-calendar date helpers. Days are YYYY-MM-DD strings in the user's own time zone
// (the system clock), so a day's file matches their calendar, not UTC.
const pad = (n) => String(n).padStart(2, "0");

export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseLocal = (ymd) => { const [y, m, d] = ymd.split("-").map(Number); return new Date(y, m - 1, d); };
export const addDays = (ymd, n) => { const d = parseLocal(ymd); d.setDate(d.getDate() + n); return localDate(d); };
/** Monday of the week that contains `ymd`. */
export const weekStart = (ymd) => addDays(ymd, -((parseLocal(ymd).getDay() + 6) % 7));
/** The local day of an ISO timestamp (any offset), or null. */
export const dateOf = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? localDate(new Date(iso)) : null);
