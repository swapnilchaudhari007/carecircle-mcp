// CareService: all CareCircle business logic, independent of MCP/HTTP.

import {
  Alert,
  Appointment,
  Caregiver,
  CheckIn,
  DoseEvent,
  DoseStatus,
  FamilyMessage,
  Medication,
  Member,
  Settings,
  Severity,
  addDays,
  humanTime,
  localParts,
  slotToDate,
  toMinutes,
  uid,
} from "./domain.js";
import type { Store } from "./store.js";
import type { Notifier } from "./notify.js";

/** Minutes before a scheduled time when a dose counts as "due". */
export const DUE_WINDOW_BEFORE = 60;
/** Minutes after scheduled time after which an unconfirmed dose is "overdue". */
export const OVERDUE_AFTER = 60;
/** Minutes after scheduled time after which an unconfirmed dose is "missed". */
export const MISSED_AFTER = 180;
/** Logging a dose more than this many minutes early needs confirmation. */
export const EARLY_CONFIRM = 120;

export type SlotState = "upcoming" | "due" | "overdue" | "missed" | "taken" | "skipped";

export interface DoseSlot {
  medicationId: string;
  medication: string;
  dose: string;
  instructions?: string;
  purpose?: string;
  slot: string;
  time: string;
  timeSpoken: string;
  state: SlotState;
  loggedAt?: string;
}

export interface LogDoseResult {
  outcome: "logged" | "double_dose_blocked" | "needs_confirmation" | "not_found" | "ambiguous";
  message: string;
  medication?: string;
  slot?: string;
  pillsRemaining?: number;
  candidates?: string[];
}

export class CareService {
  constructor(private store: Store, private notifier: Notifier) {}

  // ---------- clock (supports demo time travel) ----------
  async settings(): Promise<Settings> {
    return (
      (await this.store.get<Settings>("settings", "settings")) ?? {
        id: "settings",
        clockOffsetMs: 0,
        primaryMemberId: "aai",
      }
    );
  }
  async now(): Promise<Date> {
    const s = await this.settings();
    return new Date(Date.now() + (s.clockOffsetMs || 0));
  }
  async setClock(iso: string | null) {
    const s = await this.settings();
    s.clockOffsetMs = iso ? new Date(iso).getTime() - Date.now() : 0;
    await this.store.put("settings", s);
    return this.now();
  }

  // ---------- members ----------
  async member(memberId?: string): Promise<Member> {
    const id = memberId || (await this.settings()).primaryMemberId;
    const m = await this.store.get<Member>("member", id);
    if (!m) throw new Error(`Unknown member '${id}'`);
    return m;
  }
  members() {
    return this.store.list<Member>("member");
  }
  caregivers() {
    return this.store.list<Caregiver>("caregiver");
  }

  // ---------- medications ----------
  async medications(memberId: string, includeInactive = false) {
    const all = await this.store.list<Medication>("medication");
    return all
      .filter((m) => m.memberId === memberId && (includeInactive || m.active))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async upsertMedication(input: Partial<Medication> & { memberId: string; name: string }) {
    const meds = await this.medications(input.memberId, true);
    const existing = input.id
      ? meds.find((m) => m.id === input.id)
      : meds.find((m) => m.name.toLowerCase() === input.name.toLowerCase());
    const med: Medication = {
      id: existing?.id ?? uid("med"),
      memberId: input.memberId,
      name: input.name,
      dose: input.dose ?? existing?.dose ?? "1 tablet",
      purpose: input.purpose ?? existing?.purpose,
      instructions: input.instructions ?? existing?.instructions,
      times: (input.times ?? existing?.times ?? ["09:00"]).slice().sort(),
      pillsRemaining: input.pillsRemaining ?? existing?.pillsRemaining ?? 30,
      pillsPerDose: input.pillsPerDose ?? existing?.pillsPerDose ?? 1,
      active: input.active ?? existing?.active ?? true,
    };
    for (const t of med.times) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error(`Invalid time '${t}', use HH:MM (24h)`);
    }
    await this.store.put("medication", med);
    return med;
  }

  /** Fuzzy match a spoken medication name ("sugar tablet", "metformin", "BP pill"). */
  async findMedication(memberId: string, spoken: string): Promise<Medication[]> {
    const meds = await this.medications(memberId);
    const q = normalize(spoken);
    if (!q) return [];
    const exact = meds.filter((m) => normalize(m.name) === q);
    if (exact.length) return exact;
    const scored = meds
      .map((m) => {
        const hay = normalize(`${m.name} ${m.purpose ?? ""} ${aliasesFor(m).join(" ")}`);
        const words = q.split(" ").filter((w) => w.length >= 2 && !STOP.has(w));
        let score = 0;
        if (hay.includes(q)) score += 5;
        const hayWords = new Set(hay.split(" "));
        for (const w of words) if (hayWords.has(w) || (w.length >= 4 && hay.includes(w))) score += 2;
        if (words.some((w) => w.length >= 4 && normalize(m.name).startsWith(w.slice(0, 4)))) score += 3;
        score += Math.max(0, ...words.map((w) => similarity(w, normalize(m.name)))) * 4;
        return { m, score };
      })
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) return [];
    const top = scored[0].score;
    return scored.filter((x) => x.score >= top - 0.5).map((x) => x.m);
  }

  // ---------- schedule ----------
  async doseEvents(memberId: string) {
    return (await this.store.list<DoseEvent>("dose")).filter((d) => d.memberId === memberId);
  }

  async daySlots(memberId: string, date?: string): Promise<DoseSlot[]> {
    const member = await this.member(memberId);
    const now = await this.now();
    const lp = localParts(now, member.timezone);
    const day = date ?? lp.date;
    const meds = await this.medications(memberId);
    const events = await this.doseEvents(memberId);
    const byId = new Map(events.map((e) => [e.id, e]));
    const slots: DoseSlot[] = [];
    for (const med of meds) {
      for (const t of med.times) {
        const slot = `${day}T${t}`;
        const ev = byId.get(`${med.id}@${slot}`);
        let state: SlotState;
        if (ev) state = ev.status;
        else {
          const diff = minutesBetween(now, slotToDate(slot, member.timezone));
          if (diff < -DUE_WINDOW_BEFORE) state = "upcoming";
          else if (diff <= OVERDUE_AFTER) state = "due";
          else if (diff <= MISSED_AFTER) state = "overdue";
          else state = "missed";
        }
        slots.push({
          medicationId: med.id,
          medication: med.name,
          dose: med.dose,
          instructions: med.instructions,
          purpose: med.purpose,
          slot,
          time: t,
          timeSpoken: humanTime(t),
          state,
          loggedAt: ev?.at,
        });
      }
    }
    return slots.sort((a, b) => a.time.localeCompare(b.time) || a.medication.localeCompare(b.medication));
  }

  async todaysPlan(memberId?: string) {
    const member = await this.member(memberId);
    const now = await this.now();
    const lp = localParts(now, member.timezone);
    const slots = await this.daySlots(member.id);
    const appts = (await this.store.list<Appointment>("appointment"))
      .filter((a) => a.memberId === member.id && localParts(new Date(a.at), member.timezone).date === lp.date)
      .sort((a, b) => a.at.localeCompare(b.at));
    const pendingMessages = (await this.messages(member.id)).filter(
      (m) => m.direction === "to_member" && !m.deliveredAt,
    ).length;
    const dueNow = slots.filter((s) => s.state === "due" || s.state === "overdue");
    const next = slots.find((s) => s.state === "upcoming");
    const done = slots.filter((s) => s.state === "taken").length;
    const summary = buildPlanSentence(member, dueNow, next, done, slots.length, pendingMessages);
    return {
      member: member.preferredName,
      localDate: lp.date,
      localTime: lp.time,
      summary,
      dueNow,
      next: next ?? null,
      slots,
      appointments: appts,
      pendingMessages,
    };
  }

  // ---------- dose logging with safety guards ----------
  async logDose(args: {
    memberId?: string;
    medication: string;
    status?: DoseStatus;
    reason?: string;
    confirmEarly?: boolean;
  }): Promise<LogDoseResult> {
    const member = await this.member(args.memberId);
    const status = args.status ?? "taken";
    const matches = await this.findMedication(member.id, args.medication);
    if (!matches.length) {
      const meds = await this.medications(member.id);
      return {
        outcome: "not_found",
        message: `I couldn't find "${args.medication}" in ${member.preferredName}'s medicines. Their list is: ${meds
          .map((m) => m.name)
          .join(", ")}.`,
        candidates: meds.map((m) => m.name),
      };
    }

    const now = await this.now();
    // If several meds match (e.g. "my morning tablets"), prefer ones with a due/overdue slot now.
    const slots = await this.daySlots(member.id);
    let med = matches[0];
    if (matches.length > 1) {
      const dueIds = new Set(
        slots.filter((s) => s.state === "due" || s.state === "overdue").map((s) => s.medicationId),
      );
      const due = matches.filter((m) => dueIds.has(m.id));
      if (due.length === 1) med = due[0];
      else
        return {
          outcome: "ambiguous",
          message: `Did you mean ${listOr(matches.map((m) => m.name))}?`,
          candidates: matches.map((m) => m.name),
        };
    }

    // Find nearest slot (today, plus yesterday's late slots / tomorrow's early slots).
    const lp = localParts(now, member.timezone);
    const candidates: { slot: string; diff: number }[] = [];
    for (const day of [addDays(lp.date, -1), lp.date, addDays(lp.date, 1)]) {
      for (const t of med.times) {
        const slot = `${day}T${t}`;
        candidates.push({ slot, diff: minutesBetween(now, slotToDate(slot, member.timezone)) });
      }
    }
    candidates.sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff));
    const events = await this.doseEvents(member.id);
    const taken = new Map(events.filter((e) => e.medicationId === med.id).map((e) => [e.slot, e]));
    const nearest = candidates[0];
    const nearestEv = taken.get(nearest.slot);

    // SAFETY: double-dose guard.
    if (status === "taken" && nearestEv?.status === "taken") {
      const at = localParts(new Date(nearestEv.at), member.timezone).time;
      const text = `${member.preferredName} tried to log ${med.name} again, but the ${humanTime(
        nearest.slot.slice(11),
      )} dose was already taken at ${humanTime(at)}. Possible double dose — please check.`;
      await this.raiseAlert(member.id, "urgent", "double_dose", `double_dose:${med.id}@${nearest.slot}`, text);
      return {
        outcome: "double_dose_blocked",
        medication: med.name,
        slot: nearest.slot,
        message: `Wait — you already took your ${med.name} at ${humanTime(at)}. Please don't take another one. I've let the family know, just to be safe.`,
      };
    }

    // Pick the slot to log: nearest unlogged slot.
    const target = candidates.find((c) => !taken.has(c.slot)) ?? nearest;
    if (status === "taken" && target.diff < -EARLY_CONFIRM && !args.confirmEarly) {
      return {
        outcome: "needs_confirmation",
        medication: med.name,
        slot: target.slot,
        message: `Your ${med.name} isn't due until ${humanTime(target.slot.slice(11))}. Are you sure you want to take it now?`,
      };
    }

    const ev: DoseEvent = {
      id: `${med.id}@${target.slot}`,
      memberId: member.id,
      medicationId: med.id,
      slot: target.slot,
      status,
      at: now.toISOString(),
      reason: args.reason,
    };
    await this.store.put("dose", ev);
    if (status === "taken") {
      med.pillsRemaining = Math.max(0, med.pillsRemaining - med.pillsPerDose);
      await this.store.put("medication", med);
    }
    // Resolve any open missed-dose alert for this slot.
    const missKey = `missed:${med.id}@${target.slot}`;
    const open = await this.store.get<Alert>("alert", missKey);
    if (open && !open.acknowledgedAt) {
      open.acknowledgedAt = now.toISOString();
      await this.store.put("alert", open);
    }
    if (status === "skipped") {
      await this.raiseAlert(
        member.id,
        "warning",
        "skipped_dose",
        `skipped:${ev.id}`,
        `${member.preferredName} skipped ${med.name} (${humanTime(target.slot.slice(11))})${
          args.reason ? `: "${args.reason}"` : ""
        }.`,
      );
    }
    const daysLeft = this.daysLeft(med);
    let message =
      status === "taken"
        ? `Got it — ${med.name} ${med.dose} marked as taken for ${humanTime(target.slot.slice(11))}.`
        : `Okay, I've noted that you skipped ${med.name}. I'll let the family know so they're aware.`;
    if (status === "taken" && daysLeft <= 5)
      message += ` Only ${med.pillsRemaining} left — about ${daysLeft} day${daysLeft === 1 ? "" : "s"}. I'll remind the family to reorder.`;
    await this.safetyScan(member.id);
    return { outcome: "logged", medication: med.name, slot: target.slot, pillsRemaining: med.pillsRemaining, message };
  }

  // ---------- wellbeing ----------
  async checkIn(args: { memberId?: string; mood: number; pain?: number; sleptWell?: boolean; note?: string }) {
    const member = await this.member(args.memberId);
    const now = await this.now();
    const c: CheckIn = {
      id: uid("chk"),
      memberId: member.id,
      at: now.toISOString(),
      mood: clamp(Math.round(args.mood), 1, 5),
      pain: args.pain === undefined ? undefined : clamp(Math.round(args.pain), 0, 10),
      sleptWell: args.sleptWell,
      note: args.note,
    };
    await this.store.put("checkin", c);
    const alerts = await this.safetyScan(member.id);
    const fresh = alerts.filter((a) => a.createdAt >= now.toISOString());
    let reply =
      c.mood >= 4
        ? `Lovely to hear, ${member.preferredName}!`
        : c.mood === 3
          ? `Thanks for telling me, ${member.preferredName}.`
          : `I'm sorry you're not feeling great, ${member.preferredName}.`;
    if ((c.pain ?? 0) >= 7) reply += " That sounds like a lot of pain — I've told the family so someone can check on you.";
    else if (fresh.some((a) => a.kind === "low_mood"))
      reply += " You've had a few hard days, so I've asked the family to give you a call.";
    else if (c.mood <= 2) reply += " Would you like me to ask someone in the family to call you?";
    return { checkIn: c, reply };
  }

  async checkIns(memberId: string) {
    return (await this.store.list<CheckIn>("checkin"))
      .filter((c) => c.memberId === memberId)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  // ---------- family messages ----------
  async messages(memberId: string) {
    return (await this.store.list<FamilyMessage>("message"))
      .filter((m) => m.memberId === memberId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async sendToFamily(args: { memberId?: string; to?: string; text: string }) {
    const member = await this.member(args.memberId);
    const cgs = await this.caregivers();
    const target = args.to ? cgs.find((c) => matchesPerson(c, args.to!)) : undefined;
    const now = await this.now();
    const msg: FamilyMessage = {
      id: uid("msg"),
      memberId: member.id,
      direction: "from_member",
      from: member.preferredName,
      to: target?.name ?? "family",
      text: args.text,
      createdAt: now.toISOString(),
      deliveredAt: now.toISOString(),
    };
    await this.store.put("message", msg);
    await this.notifier.send({
      severity: "info",
      subject: `Message from ${member.preferredName}`,
      body: `${member.preferredName} says: "${args.text}"`,
      to: target ? [target] : cgs.filter((c) => c.notify),
    });
    return { message: msg, reply: `Done — I've sent that to ${target?.name ?? "the family"}.` };
  }

  async leaveMessageForMember(args: { memberId?: string; from: string; text: string }) {
    const member = await this.member(args.memberId);
    const msg: FamilyMessage = {
      id: uid("msg"),
      memberId: member.id,
      direction: "to_member",
      from: args.from,
      to: member.preferredName,
      text: args.text,
      createdAt: (await this.now()).toISOString(),
    };
    await this.store.put("message", msg);
    return msg;
  }

  async deliverMessages(memberId?: string) {
    const member = await this.member(memberId);
    const now = (await this.now()).toISOString();
    const pending = (await this.messages(member.id)).filter((m) => m.direction === "to_member" && !m.deliveredAt);
    for (const m of pending) {
      m.deliveredAt = now;
      await this.store.put("message", m);
    }
    return {
      count: pending.length,
      messages: pending.map((m) => ({ from: m.from, text: m.text, sentAt: m.createdAt })),
      reply: pending.length
        ? pending.map((m) => `${m.from} says: ${m.text}`).join(" ... ")
        : `No new messages right now, ${member.preferredName}.`,
    };
  }

  // ---------- help ----------
  async requestHelp(args: { memberId?: string; reason: string; urgency?: "urgent" | "soon" }) {
    const member = await this.member(args.memberId);
    const sev: Severity = args.urgency === "soon" ? "warning" : "urgent";
    const now = await this.now();
    await this.raiseAlert(
      member.id,
      sev,
      "help_request",
      `help:${now.toISOString()}`,
      `${member.preferredName} asked for help: "${args.reason}"`,
      true,
    );
    const emergency = /chest|breath|fell|fall|stroke|bleed|unconscious|faint|सीने|गिर/i.test(args.reason);
    return {
      reply: emergency
        ? `I've alerted the whole family right now. If this is an emergency, please call 112 immediately. Stay where you are — help is coming.`
        : `I've let the family know you need help. Someone will get back to you soon.`,
      notifiedFamily: true,
      suggestEmergencyNumber: emergency,
    };
  }

  // ---------- appointments ----------
  async addAppointment(a: Omit<Appointment, "id" | "memberId"> & { memberId?: string }) {
    const member = await this.member(a.memberId);
    const appt: Appointment = { ...a, id: uid("apt"), memberId: member.id, at: new Date(a.at).toISOString() };
    await this.store.put("appointment", appt);
    return appt;
  }
  async upcomingAppointments(memberId: string) {
    const now = (await this.now()).toISOString();
    return (await this.store.list<Appointment>("appointment"))
      .filter((a) => a.memberId === memberId && a.at >= now)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  // ---------- refills ----------
  daysLeft(med: Medication) {
    const perDay = med.times.length * med.pillsPerDose;
    return perDay ? Math.floor(med.pillsRemaining / perDay) : Infinity;
  }
  async refillForecast(memberId?: string) {
    const member = await this.member(memberId);
    const meds = await this.medications(member.id);
    const now = await this.now();
    const today = localParts(now, member.timezone).date;
    const items = meds
      .map((m) => {
        const d = this.daysLeft(m);
        return {
          medication: m.name,
          pillsRemaining: m.pillsRemaining,
          daysLeft: d,
          runsOutOn: addDays(today, d),
          reorderNow: d <= 5,
        };
      })
      .sort((a, b) => a.daysLeft - b.daysLeft);
    return items;
  }
  async recordRefill(args: { memberId?: string; medication: string; pillsAdded: number }) {
    const member = await this.member(args.memberId);
    const [med] = await this.findMedication(member.id, args.medication);
    if (!med) throw new Error(`Unknown medication ${args.medication}`);
    med.pillsRemaining += args.pillsAdded;
    await this.store.put("medication", med);
    return med;
  }

  // ---------- adherence ----------
  async adherence(memberId?: string, days = 7) {
    const member = await this.member(memberId);
    const now = await this.now();
    const today = localParts(now, member.timezone).date;
    const meds = await this.medications(member.id);
    const events = await this.doseEvents(member.id);
    const byId = new Map(events.map((e) => [e.id, e]));
    const perMed = meds.map((med) => {
      let scheduled = 0,
        taken = 0,
        skipped = 0,
        missed = 0,
        late = 0;
      for (let i = days - 1; i >= 0; i--) {
        const day = addDays(today, -i);
        for (const t of med.times) {
          const slot = `${day}T${t}`;
          const due = slotToDate(slot, member.timezone);
          if (minutesBetween(now, due) < MISSED_AFTER && !byId.has(`${med.id}@${slot}`)) continue; // not finished yet
          scheduled++;
          const ev = byId.get(`${med.id}@${slot}`);
          if (!ev) missed++;
          else if (ev.status === "skipped") skipped++;
          else {
            taken++;
            if (minutesBetween(new Date(ev.at), due) > OVERDUE_AFTER) late++;
          }
        }
      }
      return {
        medication: med.name,
        scheduled,
        taken,
        skipped,
        missed,
        late,
        adherencePct: scheduled ? Math.round((taken / scheduled) * 100) : 100,
      };
    });
    const tot = perMed.reduce((a, m) => ({ s: a.s + m.scheduled, t: a.t + m.taken }), { s: 0, t: 0 });
    // streak: consecutive full days ending yesterday/today
    let streak = 0;
    for (let i = 0; i < 60; i++) {
      const day = addDays(today, -i);
      const all = meds.flatMap((m) => m.times.map((t) => ({ m, slot: `${day}T${t}` })));
      const finished = all.filter(
        (x) => byId.has(`${x.m.id}@${x.slot}`) || minutesBetween(now, slotToDate(x.slot, member.timezone)) >= MISSED_AFTER,
      );
      if (i === 0 && finished.length < all.length && finished.every((x) => byId.get(`${x.m.id}@${x.slot}`)?.status === "taken"))
        continue; // today in progress and clean so far
      if (all.length && all.every((x) => byId.get(`${x.m.id}@${x.slot}`)?.status === "taken")) streak++;
      else break;
    }
    return { days, overallPct: tot.s ? Math.round((tot.t / tot.s) * 100) : 100, perfectDayStreak: streak, perMed };
  }

  // ---------- alerts & safety scan ----------
  async alerts(memberId?: string, includeAcknowledged = false) {
    const member = await this.member(memberId);
    return (await this.store.list<Alert>("alert"))
      .filter((a) => a.memberId === member.id && (includeAcknowledged || !a.acknowledgedAt))
      .sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || b.createdAt.localeCompare(a.createdAt));
  }
  async acknowledgeAlert(id: string) {
    const a = await this.store.get<Alert>("alert", id);
    if (!a) throw new Error(`No alert ${id}`);
    a.acknowledgedAt = (await this.now()).toISOString();
    await this.store.put("alert", a);
    return a;
  }

  async raiseAlert(memberId: string, severity: Severity, kind: string, key: string, text: string, force = false) {
    const existing = await this.store.get<Alert>("alert", key);
    if (existing && !force) return existing;
    const alert: Alert = { id: key, memberId, severity, kind, text, createdAt: (await this.now()).toISOString() };
    if (severity !== "info") {
      const cgs = (await this.caregivers()).filter((c) => c.notify);
      await this.notifier.send({ severity, subject: `CareCircle: ${kind.replace(/_/g, " ")}`, body: text, to: cgs });
      alert.notified = true;
    }
    await this.store.put("alert", alert);
    return alert;
  }

  /**
   * Proactive safety scan — the "circle" in CareCircle. Detects:
   *  missed doses, repeated misses, low-mood trends, high pain, silence (no
   *  interaction by late morning) and low pill stock.
   */
  async safetyScan(memberId?: string): Promise<Alert[]> {
    const member = await this.member(memberId);
    const now = await this.now();
    const lp = localParts(now, member.timezone);
    const meds = await this.medications(member.id);
    const events = await this.doseEvents(member.id);
    const byId = new Map(events.map((e) => [e.id, e]));
    const name = member.preferredName;

    // 1. missed doses today + consecutive misses
    for (const med of meds) {
      const recent: { slot: string; missed: boolean }[] = [];
      for (const day of [addDays(lp.date, -2), addDays(lp.date, -1), lp.date]) {
        for (const t of med.times) {
          const slot = `${day}T${t}`;
          const diff = minutesBetween(now, slotToDate(slot, member.timezone));
          if (diff < MISSED_AFTER) continue;
          const ev = byId.get(`${med.id}@${slot}`);
          recent.push({ slot, missed: !ev || ev.status === "skipped" });
          if (!ev && day === lp.date)
            await this.raiseAlert(
              member.id,
              "warning",
              "missed_dose",
              `missed:${med.id}@${slot}`,
              `${name} hasn't confirmed ${med.name} (${humanTime(t)}) — it's now ${humanTime(lp.time)}.`,
            );
        }
      }
      const tail = recent.slice(-2);
      if (tail.length === 2 && tail.every((r) => r.missed))
        await this.raiseAlert(
          member.id,
          "urgent",
          "repeated_missed",
          `repeat:${med.id}@${tail[1].slot}`,
          `${name} has missed ${med.name} ${tail.length} times in a row. ${
            med.purpose ? `It's for ${med.purpose}, so a call to check in is a good idea.` : "Please check in."
          }`,
        );
    }

    // 2. mood & pain trends
    const checks = await this.checkIns(member.id);
    const last3 = checks.slice(-3);
    if (last3.length === 3 && last3.every((c) => c.mood <= 2))
      await this.raiseAlert(
        member.id,
        "warning",
        "low_mood",
        `lowmood:${last3[2].id}`,
        `${name} has reported low mood ${last3.length} check-ins in a row${
          last3[2].note ? ` (latest: "${last3[2].note}")` : ""
        }. A call or visit might really help.`,
      );
    else if (checks.length >= 4) {
      const prev = checks.slice(-8, -1);
      const avg = prev.reduce((a, c) => a + c.mood, 0) / prev.length;
      const latest = checks[checks.length - 1];
      if (avg - latest.mood >= 2)
        await this.raiseAlert(
          member.id,
          "warning",
          "low_mood",
          `mooddrop:${latest.id}`,
          `${name}'s mood dropped sharply today (${latest.mood}/5 vs a usual ${avg.toFixed(1)}/5).`,
        );
    }
    const latest = checks[checks.length - 1];
    if (latest && (latest.pain ?? 0) >= 7)
      await this.raiseAlert(
        member.id,
        "warning",
        "high_pain",
        `pain:${latest.id}`,
        `${name} reported pain of ${latest.pain}/10${latest.note ? `: "${latest.note}"` : ""}.`,
      );

    // 3. silence signal — no interaction today by 11:00
    if (lp.minutes >= toMinutes("11:00")) {
      const todayIso = slotToDate(`${lp.date}T00:00`, member.timezone).toISOString();
      const anyToday =
        events.some((e) => e.at >= todayIso) ||
        checks.some((c) => c.at >= todayIso) ||
        (await this.messages(member.id)).some((m) => m.direction === "from_member" && m.createdAt >= todayIso);
      if (!anyToday)
        await this.raiseAlert(
          member.id,
          "warning",
          "silence",
          `silence:${lp.date}`,
          `No check-in or medicine confirmation from ${name} yet today (it's ${humanTime(lp.time)}).`,
        );
    }

    // 4. refills
    for (const med of meds) {
      const d = this.daysLeft(med);
      if (d <= 5)
        await this.raiseAlert(
          member.id,
          d <= 2 ? "warning" : "info",
          "refill",
          `refill:${med.id}:${d <= 2 ? "low" : "soon"}`,
          `${med.name} will run out in about ${d} day${d === 1 ? "" : "s"} (${med.pillsRemaining} left). Time to reorder.`,
        );
    }
    return this.alerts(member.id);
  }

  // ---------- digest data ----------
  async digestData(memberId?: string) {
    const member = await this.member(memberId);
    const [plan, adherence, alerts, refills, checks, appts, msgs] = await Promise.all([
      this.todaysPlan(member.id),
      this.adherence(member.id, 7),
      this.safetyScan(member.id),
      this.refillForecast(member.id),
      this.checkIns(member.id),
      this.upcomingAppointments(member.id),
      this.messages(member.id),
    ]);
    return {
      member: { name: member.name, preferredName: member.preferredName, conditions: member.conditions ?? [] },
      today: {
        date: plan.localDate,
        time: plan.localTime,
        taken: plan.slots.filter((s) => s.state === "taken").map((s) => `${s.medication} ${s.timeSpoken}`),
        outstanding: plan.slots
          .filter((s) => ["due", "overdue", "missed"].includes(s.state))
          .map((s) => `${s.medication} ${s.timeSpoken} (${s.state})`),
        upcoming: plan.slots.filter((s) => s.state === "upcoming").map((s) => `${s.medication} ${s.timeSpoken}`),
      },
      adherence,
      recentCheckIns: checks.slice(-5).map((c) => ({ at: c.at, mood: c.mood, pain: c.pain, note: c.note })),
      openAlerts: alerts.map((a) => ({ severity: a.severity, text: a.text })),
      refillsNeeded: refills.filter((r) => r.reorderNow),
      nextAppointment: appts[0] ?? null,
      recentMessagesFromMember: msgs.filter((m) => m.direction === "from_member").slice(-3).map((m) => m.text),
    };
  }
}

// ---------- helpers ----------
const STOP = new Set([
  "the", "my", "tablet", "tablets", "pill", "pills", "medicine", "medicines", "goli", "dawa", "dawai", "and", "for",
  "took", "taken", "take", "had", "have", "just", "now", "already", "skipped", "skip", "didn", "did", "not", "today",
  "this", "that", "morning", "evening", "night", "yes", "okay", "le", "li", "liya", "hai", "maine",
]);

function aliasesFor(m: Medication): string[] {
  const p = (m.purpose ?? "").toLowerCase();
  const a: string[] = [];
  if (/sugar|diabet/.test(p)) a.push("sugar", "diabetes", "शुगर");
  if (/pressure|bp|hypert/.test(p)) a.push("bp", "pressure", "blood pressure");
  if (/cholest/.test(p)) a.push("cholesterol", "heart");
  if (/thyroid/.test(p)) a.push("thyroid");
  if (/vitamin|bone|calcium/.test(p)) a.push("vitamin", "calcium", "bones");
  return a;
}

export function normalize(s: string) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a: string, b: string) {
  // Dice coefficient over bigrams — tolerant to speech-to-text misspellings ("met forming").
  const grams = (s: string) => {
    const t = s.replace(/\s/g, "");
    const out: string[] = [];
    for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
    return out;
  };
  const A = grams(a),
    B = grams(b);
  if (!A.length || !B.length) return 0;
  const bag = new Map<string, number>();
  for (const g of B) bag.set(g, (bag.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of A) {
    const n = bag.get(g) ?? 0;
    if (n) {
      hit++;
      bag.set(g, n - 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
}

function matchesPerson(c: Caregiver, spoken: string) {
  const q = normalize(spoken);
  return normalize(c.name).split(" ").some((w) => q.includes(w)) || q.includes(normalize(c.relation));
}

export function minutesBetween(now: Date, then: Date) {
  return Math.round((now.getTime() - then.getTime()) / 60000);
}
function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
function sevRank(s: Severity) {
  return s === "urgent" ? 3 : s === "warning" ? 2 : 1;
}
function listOr(xs: string[]) {
  return xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`;
}

function buildPlanSentence(
  member: Member,
  dueNow: DoseSlot[],
  next: DoseSlot | undefined,
  done: number,
  total: number,
  pendingMessages: number,
) {
  const parts: string[] = [];
  if (dueNow.length)
    parts.push(
      `Right now it's time for ${dueNow
        .map((s) => `${s.medication} ${s.dose}${s.instructions ? `, ${s.instructions}` : ""}`)
        .join("; and ")}.`,
    );
  else if (next) parts.push(`Nothing due right now. Next is ${next.medication} at ${next.timeSpoken}.`);
  else if (total) parts.push(`That's everything for today — well done, ${member.preferredName}!`);
  parts.push(`${done} of ${total} doses done today.`);
  if (pendingMessages) parts.push(`You have ${pendingMessages} new message${pendingMessages > 1 ? "s" : ""} from family.`);
  return parts.join(" ");
}
