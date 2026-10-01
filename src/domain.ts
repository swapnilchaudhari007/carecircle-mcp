// CareCircle domain model and time helpers.

export type Language = "en" | "hi" | "mr";
export type Severity = "info" | "warning" | "urgent";

export interface Member {
  id: string;
  name: string;
  preferredName: string; // what Alexa calls them, e.g. "Aai"
  timezone: string; // IANA, e.g. Asia/Kolkata
  language: Language;
  conditions?: string[];
}

export interface Caregiver {
  id: string;
  name: string;
  relation: string;
  phone?: string;
  email?: string;
  notify: boolean;
}

export interface Medication {
  id: string;
  memberId: string;
  name: string;
  dose: string; // "500 mg"
  purpose?: string; // "blood sugar"
  instructions?: string; // "after breakfast"
  times: string[]; // local "HH:MM"
  pillsRemaining: number;
  pillsPerDose: number;
  active: boolean;
}

export type DoseStatus = "taken" | "skipped";

export interface DoseEvent {
  id: string; // `${medicationId}@${slot}`
  memberId: string;
  medicationId: string;
  slot: string; // local "YYYY-MM-DDTHH:MM"
  status: DoseStatus;
  at: string; // ISO UTC when logged
  reason?: string;
}

export interface CheckIn {
  id: string;
  memberId: string;
  at: string;
  mood: number; // 1 (very low) .. 5 (great)
  pain?: number; // 0..10
  sleptWell?: boolean;
  note?: string;
}

export interface FamilyMessage {
  id: string;
  memberId: string;
  direction: "to_member" | "from_member";
  from: string;
  to: string;
  text: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface Alert {
  id: string; // dedupe key
  memberId: string;
  severity: Severity;
  kind: string;
  text: string;
  createdAt: string;
  acknowledgedAt?: string;
  notified?: boolean;
}

export interface Appointment {
  id: string;
  memberId: string;
  title: string;
  at: string; // ISO
  location?: string;
  notes?: string;
}

export interface Settings {
  id: "settings";
  clockOffsetMs: number; // demo time-travel
  primaryMemberId: string;
}

// ---------- time helpers ----------

export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  minutes: number; // minutes since local midnight
}

export function localParts(d: Date, tz: string): LocalParts {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const time = `${p.hour}:${p.minute}`;
  return { date: `${p.year}-${p.month}-${p.day}`, time, minutes: toMinutes(time) };
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Convert a local wall-clock slot ("YYYY-MM-DDTHH:MM") in tz to a UTC Date. */
export function slotToDate(slot: string, tz: string): Date {
  const guess = new Date(`${slot}:00Z`);
  // offset = local(guess) - guess
  const lp = localParts(guess, tz);
  const asUtc = new Date(`${lp.date}T${lp.time}:00Z`).getTime();
  const offset = asUtc - guess.getTime();
  return new Date(guess.getTime() - offset);
}

export function humanTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}
