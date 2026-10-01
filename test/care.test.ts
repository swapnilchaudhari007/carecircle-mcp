import { describe, it, expect, beforeEach } from "vitest";
import { CareService } from "../src/care.js";
import { MemoryStore } from "../src/store.js";
import { seedDemo } from "../src/seed.js";
import { slotToDate, localParts, addDays } from "../src/domain.js";
import type { Notifier, Notification } from "../src/notify.js";
import { parseMood } from "../src/agent.js";

class TestNotifier implements Notifier {
  sent: Notification[] = [];
  async send(n: Notification) {
    this.sent.push(n);
  }
  recent() {
    return [];
  }
}

const TZ = "Asia/Kolkata";
let care: CareService;
let notifier: TestNotifier;
let today: string;

async function at(local: string) {
  await care.setClock(slotToDate(`${today}T${local}`, TZ).toISOString());
}

beforeEach(async () => {
  const store = new MemoryStore();
  notifier = new TestNotifier();
  care = new CareService(store, notifier);
  await seedDemo(store, new Date(), true);
  today = localParts(new Date(), TZ).date;
});

describe("time helpers", () => {
  it("converts IST slots to UTC", () => {
    expect(slotToDate("2026-10-01T08:30", TZ).toISOString()).toBe("2026-10-01T03:00:00.000Z");
  });
});

describe("medicine matching", () => {
  it("understands spoken names and purposes", async () => {
    expect((await care.findMedication("aai", "I took my BP pill"))[0]?.name).toBe("Amlodipine");
    expect((await care.findMedication("aai", "sugar tablet"))[0]?.name).toBe("Metformin");
    expect((await care.findMedication("aai", "met forming"))[0]?.name).toBe("Metformin");
    expect((await care.findMedication("aai", "cholesterol"))[0]?.name).toBe("Atorvastatin");
    expect(await care.findMedication("aai", "aspirin")).toHaveLength(0);
  });
});

describe("dose logging", () => {
  it("logs the nearest slot and decrements stock", async () => {
    await at("08:40");
    const r = await care.logDose({ medication: "metformin" });
    expect(r.outcome).toBe("logged");
    expect(r.slot).toBe(`${today}T08:30`);
    expect(r.pillsRemaining).toBe(40);
  });

  it("blocks a double dose and alerts the family", async () => {
    await at("08:40");
    await care.logDose({ medication: "metformin" });
    await at("09:30");
    const r = await care.logDose({ medication: "sugar tablet" });
    expect(r.outcome).toBe("double_dose_blocked");
    expect(notifier.sent.some((n) => n.severity === "urgent" && /double dose/i.test(n.body))).toBe(true);
  });

  it("asks for confirmation when very early", async () => {
    await at("17:00");
    const r = await care.logDose({ medication: "atorvastatin" });
    expect(r.outcome).toBe("needs_confirmation");
    const r2 = await care.logDose({ medication: "atorvastatin", confirmEarly: true });
    expect(r2.outcome).toBe("logged");
  });

  it("alerts family on a skipped dose", async () => {
    await at("09:05");
    const r = await care.logDose({ medication: "amlodipine", status: "skipped", reason: "feeling dizzy" });
    expect(r.outcome).toBe("logged");
    expect(notifier.sent.some((n) => /skipped Amlodipine/.test(n.body))).toBe(true);
  });
});

describe("safety scan", () => {
  it("raises missed-dose and silence alerts", async () => {
    await at("12:30");
    const alerts = await care.safetyScan();
    const kinds = alerts.map((a) => a.kind);
    expect(kinds).toContain("missed_dose");
    expect(kinds).toContain("silence");
    expect(kinds).toContain("refill");
  });

  it("detects a low-mood trend on the third low check-in", async () => {
    await at("10:00");
    const r = await care.checkIn({ mood: 2, note: "lonely" });
    expect(r.reply).toMatch(/family/);
    expect((await care.alerts()).some((a) => a.kind === "low_mood")).toBe(true);
  });

  it("flags repeated misses", async () => {
    await care.setClock(slotToDate(`${addDays(today, 1)}T13:00`, TZ).toISOString());
    const alerts = await care.safetyScan();
    expect(alerts.some((a) => a.kind === "repeated_missed")).toBe(true);
  });
});

describe("adherence & refills", () => {
  it("computes adherence with the seeded missed dose", async () => {
    await at("08:00");
    const a = await care.adherence(undefined, 7);
    const met = a.perMed.find((m) => m.medication === "Metformin")!;
    expect(met.missed).toBe(1);
    expect(a.overallPct).toBeLessThan(100);
  });
  it("forecasts low Amlodipine stock", async () => {
    const f = await care.refillForecast();
    expect(f[0].medication).toBe("Amlodipine");
    expect(f[0].reorderNow).toBe(true);
  });
});

describe("intent parsing", () => {
  it("maps feelings to mood", () => {
    expect(parseMood("i feel lonely")).toBe(2);
    expect(parseMood("feeling great today")).toBe(5);
    expect(parseMood("i'm okay")).toBe(3);
  });
});
