// The CareCircle MCP server: tools, resources and prompts that an Alexa+ agent (or any MCP client) can use.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CareService } from "./care.js";
import { familyDigest } from "./ai.js";
import type { Language } from "./domain.js";

export const SERVER_INFO = { name: "carecircle", title: "CareCircle", version: "1.0.0" };

const INSTRUCTIONS = `CareCircle helps an older adult ("the member", usually addressed by their preferred name, e.g. "Aai") take medicines safely and stay connected to their family ("the circle").
Speak warmly, simply and briefly — the listener may be elderly and hard of hearing. Every tool result includes a "speak" field: say it (you may rephrase lightly), never contradict it.
Rules:
- When the member says they took/had a medicine, call log_dose. If it returns outcome=double_dose_blocked, clearly tell them NOT to take another.
- If outcome=needs_confirmation, ask them, and call log_dose again with confirmEarly=true only if they confirm.
- Never give medical advice or change doses. For symptoms like chest pain, breathlessness, a fall, or confusion, call request_help immediately.
- After a morning greeting, a good routine is: get_todays_plan → check_messages → record_check_in.
- memberId is optional everywhere; it defaults to the household's primary member.`;

type Json = Record<string, unknown>;
function result(speak: string, data: Json = {}) {
  const payload = { speak, ...data };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 1) }],
    structuredContent: payload,
  };
}
function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ speak: `Sorry, something went wrong: ${msg}` }) }] };
}

const memberId = z.string().optional().describe("Member id. Omit for the primary member.");

export function buildMcpServer(care: CareService): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: INSTRUCTIONS,
    capabilities: { logging: {} },
  });

  // ---------------- member-facing tools ----------------
  server.registerTool(
    "get_todays_plan",
    {
      title: "Today's medicine plan",
      description:
        "What medicines are due now, what's next, what's been taken today, today's appointments and whether family messages are waiting. Use for 'what do I take now?', 'did I take my medicines?', 'good morning'.",
      inputSchema: { memberId },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ memberId }) => {
      try {
        const p = await care.todaysPlan(memberId);
        return result(p.summary, p as unknown as Json);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "log_dose",
    {
      title: "Log a medicine dose",
      description:
        "Record that the member took (or skipped) a medicine. Accepts spoken names like 'sugar tablet', 'BP pill', 'metformin'. Includes a double-dose safety guard and early-dose confirmation.",
      inputSchema: {
        memberId,
        medication: z.string().describe("Medicine name as spoken, e.g. 'metformin' or 'my sugar tablet'"),
        status: z.enum(["taken", "skipped"]).default("taken"),
        reason: z.string().optional().describe("Why a dose was skipped, if given"),
        confirmEarly: z.boolean().optional().describe("Set true only after the member confirms taking an early dose"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const r = await care.logDose(args);
        return result(r.message, r as unknown as Json);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "record_check_in",
    {
      title: "Daily wellbeing check-in",
      description:
        "Record how the member is feeling. Map words to mood 1-5 (1 very low/sad/lonely, 3 okay, 5 great). Pain 0-10 if mentioned. Detects low-mood trends and high pain and quietly alerts family.",
      inputSchema: {
        memberId,
        mood: z.number().min(1).max(5),
        pain: z.number().min(0).max(10).optional(),
        sleptWell: z.boolean().optional(),
        note: z.string().optional().describe("Anything they said about how they feel, in their words"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const r = await care.checkIn(args);
        return result(r.reply, { checkIn: r.checkIn });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "check_messages",
    {
      title: "Read family messages",
      description: "Read out (and mark delivered) messages the family left for the member.",
      inputSchema: { memberId },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ memberId }) => {
      try {
        const r = await care.deliverMessages(memberId);
        return result(r.reply, r as unknown as Json);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "send_family_message",
    {
      title: "Send a message to family",
      description:
        "Send a message from the member to a family member (by name or relation, e.g. 'Swapnil', 'my son') or to everyone. Use for 'tell Priya I need groceries'.",
      inputSchema: {
        memberId,
        to: z.string().optional().describe("Name or relation; omit to message the whole circle"),
        text: z.string().min(1),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const r = await care.sendToFamily(args);
        return result(r.reply, { message: r.message });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "request_help",
    {
      title: "Ask the family for help",
      description:
        "Immediately alert every caregiver. Use for falls, chest pain, breathlessness, dizziness, confusion, or any 'I need help'. Use urgency='soon' for non-emergencies (e.g. 'can someone come by today').",
      inputSchema: {
        memberId,
        reason: z.string().describe("What's wrong, in the member's words"),
        urgency: z.enum(["urgent", "soon"]).default("urgent"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const r = await care.requestHelp(args);
        return result(r.reply, r as unknown as Json);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------------- caregiver-facing tools ----------------
  server.registerTool(
    "get_family_digest",
    {
      title: "Family care digest",
      description:
        "A short AI-written update for caregivers: urgent items first, then medicines, mood, refills and appointments. Supports English, Hindi and Marathi. Use for 'how is Aai doing today?'.",
      inputSchema: { memberId, language: z.enum(["en", "hi", "mr"]).default("en") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ memberId, language }) => {
      try {
        const data = await care.digestData(memberId);
        const d = await familyDigest(data, language as Language);
        return result(d.text, { digest: d.text, generatedBy: d.source, data });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_adherence_report",
    {
      title: "Medicine adherence report",
      description: "Per-medicine adherence over the last N days: taken, late, skipped, missed, plus perfect-day streak.",
      inputSchema: { memberId, days: z.number().int().min(1).max(60).default(7) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ memberId, days }) => {
      try {
        const r = await care.adherence(memberId, days);
        const worst = [...r.perMed].sort((a, b) => a.adherencePct - b.adherencePct)[0];
        return result(
          `Over the last ${days} days, ${r.overallPct}% of doses were taken.${
            worst && worst.adherencePct < 100 ? ` ${worst.medication} was the weakest at ${worst.adherencePct}%.` : ""
          }${r.perfectDayStreak ? ` Current perfect-day streak: ${r.perfectDayStreak}.` : ""}`,
          r as unknown as Json,
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "get_alerts",
    {
      title: "Open care alerts",
      description: "Runs the proactive safety scan (missed doses, repeated misses, low mood trend, pain, silence, refills) and returns open alerts.",
      inputSchema: { memberId },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ memberId }) => {
      try {
        const alerts = await care.safetyScan(memberId);
        return result(
          alerts.length ? `${alerts.length} open alert${alerts.length > 1 ? "s" : ""}. ${alerts[0].text}` : "No open alerts. All good.",
          { alerts },
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "acknowledge_alert",
    {
      title: "Acknowledge an alert",
      description: "Mark an alert as handled by a caregiver.",
      inputSchema: { alertId: z.string() },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ alertId }) => {
      try {
        const a = await care.acknowledgeAlert(alertId);
        return result("Alert marked as handled.", { alert: a });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "manage_medication",
    {
      title: "Add or update a medicine",
      description: "Caregiver tool: add a new medicine or change dose, times (24h HH:MM, local), stock or stop it (active=false).",
      inputSchema: {
        memberId,
        name: z.string(),
        dose: z.string().optional(),
        purpose: z.string().optional(),
        instructions: z.string().optional(),
        times: z.array(z.string()).optional().describe("Local 24h times, e.g. ['08:00','20:00']"),
        pillsRemaining: z.number().int().min(0).optional(),
        pillsPerDose: z.number().int().min(1).optional(),
        active: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const m = await care.member(args.memberId);
        const med = await care.upsertMedication({ ...args, memberId: m.id });
        return result(
          med.active
            ? `${med.name} ${med.dose} is set for ${med.times.join(" and ")}, with ${med.pillsRemaining} in stock.`
            : `${med.name} has been stopped.`,
          { medication: med },
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "refill_status",
    {
      title: "Refill forecast",
      description: "How many days of each medicine are left and which need reordering. Optionally record a refill.",
      inputSchema: {
        memberId,
        recordRefill: z
          .object({ medication: z.string(), pillsAdded: z.number().int().min(1) })
          .optional()
          .describe("Record pills added after buying a refill"),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ memberId, recordRefill }) => {
      try {
        if (recordRefill) await care.recordRefill({ memberId, ...recordRefill });
        const items = await care.refillForecast(memberId);
        const low = items.filter((i) => i.reorderNow);
        return result(
          low.length
            ? `Reorder soon: ${low.map((i) => `${i.medication}, ${i.daysLeft} day${i.daysLeft === 1 ? "" : "s"} left`).join("; ")}.`
            : "All medicines have more than five days of stock.",
          { items },
        );
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "leave_message_for_member",
    {
      title: "Leave a message for the member",
      description: "Caregiver tool: leave a message that Alexa will read to the member at their next interaction.",
      inputSchema: { memberId, from: z.string(), text: z.string().min(1) },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const m = await care.leaveMessageForMember(args);
        return result(`Okay, I'll pass that on at the next chance.`, { message: m });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "add_appointment",
    {
      title: "Add a doctor appointment",
      description: "Add an appointment (ISO 8601 date-time with offset, e.g. 2026-10-05T11:00:00+05:30).",
      inputSchema: { memberId, title: z.string(), at: z.string(), location: z.string().optional(), notes: z.string().optional() },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const a = await care.addAppointment(args);
        return result(`Added: ${a.title}.`, { appointment: a });
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------------- resources ----------------
  server.registerResource(
    "care-plan",
    "carecircle://care-plan",
    { title: "Care plan", description: "Member profile, caregivers, medicines and upcoming appointments", mimeType: "application/json" },
    async (uri) => {
      const m = await care.member();
      const plan = {
        member: m,
        caregivers: (await care.caregivers()).map(({ name, relation }) => ({ name, relation })),
        medications: await care.medications(m.id),
        appointments: await care.upcomingAppointments(m.id),
      };
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(plan, null, 2) }] };
    },
  );

  // ---------------- prompts ----------------
  server.registerPrompt(
    "morning_routine",
    { title: "Morning routine", description: "Warm good-morning flow: plan, messages, wellbeing check-in" },
    async () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Greet the member warmly by their preferred name. Call get_todays_plan and tell them what's due. Then call check_messages. Finally ask how they slept and how they feel, and record_check_in with their answer.",
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    "caregiver_briefing",
    {
      title: "Caregiver briefing",
      description: "Daily briefing for a family caregiver in their language",
      argsSchema: { language: z.enum(["en", "hi", "mr"]).optional() },
    },
    async ({ language }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Call get_family_digest with language=${language ?? "en"} and read it out. If there are urgent alerts, offer to leave a message for the member or to acknowledge the alert.`,
          },
        },
      ],
    }),
  );

  return server;
}
