// Amazon Bedrock integration (Converse API). Used for:
//  1. the multilingual family digest narrative, and
//  2. the agent loop in the Alexa+ web simulator (tool use over MCP).
// Everything degrades gracefully to deterministic templates when Bedrock is not configured.

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type { Language } from "./domain.js";

export const MODEL_ID = process.env.BEDROCK_MODEL_ID; // e.g. us.amazon.nova-pro-v1:0
let client: BedrockRuntimeClient | undefined;

export function bedrockEnabled() {
  return Boolean(MODEL_ID);
}

function bedrock() {
  return (client ??= new BedrockRuntimeClient({ region: process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? "us-east-1" }));
}

export async function converse(opts: {
  system: string;
  messages: Message[];
  tools?: Tool[];
  maxTokens?: number;
}) {
  if (!MODEL_ID) throw new Error("Bedrock not configured (set BEDROCK_MODEL_ID)");
  return bedrock().send(
    new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: opts.system }],
      messages: opts.messages,
      inferenceConfig: { maxTokens: opts.maxTokens ?? 700, temperature: 0.3 },
      toolConfig: opts.tools?.length ? { tools: opts.tools } : undefined,
    }),
  );
}

export function textOf(content: ContentBlock[] | undefined) {
  return (content ?? [])
    .map((c) => ("text" in c ? c.text : ""))
    .join("")
    .trim();
}

const LANG_NAME: Record<Language, string> = { en: "English", hi: "Hindi (Devanagari script)", mr: "Marathi (Devanagari script)" };

type Digest = Awaited<ReturnType<import("./care.js").CareService["digestData"]>>;

export async function familyDigest(data: Digest, language: Language = "en"): Promise<{ text: string; source: string }> {
  if (bedrockEnabled()) {
    try {
      const r = await converse({
        system:
          "You write a short, warm daily care update for adult children about their aging parent. " +
          "Lead with what needs action (urgent items first), then reassurance. Be specific with medicine names and times. " +
          "Never give medical advice or change dosages; suggest calling the doctor when appropriate. " +
          "Max 120 words. Plain text, no markdown headings. Write in " +
          LANG_NAME[language] +
          ".",
        messages: [{ role: "user", content: [{ text: `Care data (JSON):\n${JSON.stringify(data)}` }] }],
        maxTokens: 400,
      });
      const text = textOf(r.output?.message?.content);
      if (text) return { text, source: `bedrock:${MODEL_ID}` };
    } catch (e) {
      console.error("[ai] digest fallback:", (e as Error).message);
    }
  }
  return { text: templateDigest(data, language), source: "template" };
}

export function templateDigest(d: Digest, language: Language): string {
  const n = d.member.preferredName;
  const urgent = d.openAlerts.filter((a) => a.severity !== "info");
  if (language === "hi") {
    return [
      urgent.length ? `ध्यान दें: ${urgent.map((a) => a.text).join(" ")}` : `${n} के लिए आज कोई गंभीर चेतावनी नहीं है।`,
      `आज ली गई दवाइयाँ: ${d.today.taken.length ? d.today.taken.join(", ") : "अभी तक कोई नहीं"}।`,
      d.today.outstanding.length ? `बाकी: ${d.today.outstanding.join(", ")}।` : "",
      `पिछले 7 दिनों में दवा पालन: ${d.adherence.overallPct}%।`,
      d.refillsNeeded.length ? `जल्द खत्म होने वाली दवा: ${d.refillsNeeded.map((r) => r.medication).join(", ")}।` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (language === "mr") {
    return [
      urgent.length ? `लक्ष द्या: ${urgent.map((a) => a.text).join(" ")}` : `${n} साठी आज कोणताही गंभीर इशारा नाही.`,
      `आज घेतलेली औषधे: ${d.today.taken.length ? d.today.taken.join(", ") : "अजून नाही"}.`,
      d.today.outstanding.length ? `बाकी: ${d.today.outstanding.join(", ")}.` : "",
      `मागील ७ दिवसांतील पालन: ${d.adherence.overallPct}%.`,
      d.refillsNeeded.length ? `लवकर संपणारी औषधे: ${d.refillsNeeded.map((r) => r.medication).join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }
  const mood = d.recentCheckIns.length ? d.recentCheckIns[d.recentCheckIns.length - 1] : undefined;
  return [
    urgent.length ? `Needs attention: ${urgent.map((a) => a.text).join(" ")}` : `No urgent concerns for ${n} today.`,
    `Taken today: ${d.today.taken.length ? d.today.taken.join(", ") : "nothing confirmed yet"}.`,
    d.today.outstanding.length ? `Outstanding: ${d.today.outstanding.join(", ")}.` : "",
    `7-day adherence ${d.adherence.overallPct}%${d.adherence.perfectDayStreak ? `, ${d.adherence.perfectDayStreak}-day perfect streak` : ""}.`,
    mood ? `Latest mood ${mood.mood}/5${mood.note ? ` ("${mood.note}")` : ""}.` : "",
    d.refillsNeeded.length ? `Reorder soon: ${d.refillsNeeded.map((r) => `${r.medication} (${r.daysLeft}d left)`).join(", ")}.` : "",
    d.nextAppointment ? `Next appointment: ${d.nextAppointment.title}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
