// Demo household: "Aai" (Sunita, 72) in Thane, cared for by her son and daughter who live in other cities.
// History is generated relative to "now" so the demo always tells the same story:
//   - mostly good adherence, one missed evening Metformin two days ago
//   - mood trending down over the last 3 check-ins (loneliness)
//   - Amlodipine running low (refill alert)

import type { Appointment, Caregiver, CheckIn, DoseEvent, FamilyMessage, Medication, Member, Settings } from "./domain.js";
import { addDays, localParts, slotToDate } from "./domain.js";
import type { Store } from "./store.js";

export async function seedDemo(store: Store, now = new Date(), force = false) {
  if (!force && (await store.get("member", "aai"))) return false;
  const tz = "Asia/Kolkata";

  const member: Member = {
    id: "aai",
    name: "Sunita Chaudhari",
    preferredName: "Aai",
    timezone: tz,
    language: "en",
    conditions: ["Type 2 diabetes", "Hypertension", "High cholesterol"],
  };
  const caregivers: Caregiver[] = [
    { id: "cg_swapnil", name: "Swapnil", relation: "son", phone: "+91-90000-00001", notify: true },
    { id: "cg_priya", name: "Priya", relation: "daughter", email: "priya@example.com", notify: true },
  ];
  const meds: Medication[] = [
    {
      id: "med_metformin",
      memberId: "aai",
      name: "Metformin",
      dose: "500 mg",
      purpose: "blood sugar (diabetes)",
      instructions: "after food",
      times: ["08:30", "20:30"],
      pillsRemaining: 41,
      pillsPerDose: 1,
      active: true,
    },
    {
      id: "med_amlodipine",
      memberId: "aai",
      name: "Amlodipine",
      dose: "5 mg",
      purpose: "blood pressure",
      instructions: "with water, morning",
      times: ["09:00"],
      pillsRemaining: 4,
      pillsPerDose: 1,
      active: true,
    },
    {
      id: "med_atorvastatin",
      memberId: "aai",
      name: "Atorvastatin",
      dose: "10 mg",
      purpose: "cholesterol",
      instructions: "at bedtime",
      times: ["21:30"],
      pillsRemaining: 22,
      pillsPerDose: 1,
      active: true,
    },
  ];

  for (const k of ["member", "caregiver", "medication", "dose", "checkin", "message", "alert", "appointment"] as const) {
    for (const item of await store.list<{ id: string }>(k)) await store.delete(k, item.id);
  }
  await store.put("member", member);
  for (const c of caregivers) await store.put("caregiver", c);
  for (const m of meds) await store.put("medication", m);

  const today = localParts(now, tz).date;
  const jitter = [4, -6, 12, 2, 25, -3, 8, 15, 0, 7, -10, 30, 5, 9];
  let j = 0;
  for (let i = 6; i >= 1; i--) {
    const day = addDays(today, -i);
    for (const m of meds) {
      for (const t of m.times) {
        const slot = `${day}T${t}`;
        if (i === 2 && m.id === "med_metformin" && t === "20:30") continue; // missed
        const at = new Date(slotToDate(slot, tz).getTime() + jitter[j++ % jitter.length] * 60000);
        const ev: DoseEvent = { id: `${m.id}@${slot}`, memberId: "aai", medicationId: m.id, slot, status: "taken", at: at.toISOString() };
        await store.put("dose", ev);
      }
    }
  }

  const moods: [number, number, string?][] = [
    [4, 2],
    [4, 1],
    [5, 1, "Priya video-called, very happy"],
    [3, 3],
    [2, 3, "Feeling lonely, nobody visited"],
    [2, 4, "Knee is hurting, didn't go for walk"],
  ];
  for (let i = 0; i < moods.length; i++) {
    const day = addDays(today, -(moods.length - i));
    const [mood, pain, note] = moods[i];
    const c: CheckIn = {
      id: `chk_seed_${i}`,
      memberId: "aai",
      at: slotToDate(`${day}T10:15`, tz).toISOString(),
      mood,
      pain,
      sleptWell: mood >= 3,
      note,
    };
    await store.put("checkin", c);
  }

  const msg: FamilyMessage = {
    id: "msg_seed_1",
    memberId: "aai",
    direction: "to_member",
    from: "Priya",
    to: "Aai",
    text: "I'll video call you at 7 tonight. Love you!",
    createdAt: new Date(now.getTime() - 40 * 60000).toISOString(),
  };
  await store.put("message", msg);

  const appt: Appointment = {
    id: "apt_seed_1",
    memberId: "aai",
    title: "Diabetes review with Dr. Kulkarni",
    at: slotToDate(`${addDays(today, 3)}T11:00`, tz).toISOString(),
    location: "Jupiter Hospital, Thane",
    notes: "Carry last 3 months sugar readings",
  };
  await store.put("appointment", appt);

  const settings: Settings = { id: "settings", clockOffsetMs: 0, primaryMemberId: "aai" };
  await store.put("settings", settings);
  return true;
}
