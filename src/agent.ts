// "Alexa+ simulator" agent. It is a real MCP *client*: it connects to the CareCircle MCP server over
// Streamable HTTP, discovers tools with tools/list and executes them with tools/call — exactly what
// Alexa+ does with a registered MCP server. The reasoning step uses Amazon Bedrock (Converse + tool use)
// when configured, otherwise a deterministic intent router so the demo works offline.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Message, Tool } from "@aws-sdk/client-bedrock-runtime";
import { bedrockEnabled, converse, textOf, MODEL_ID } from "./ai.js";

export interface TraceStep {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
  ms: number;
}
export interface AgentTurn {
  reply: string;
  trace: TraceStep[];
  engine: string;
}
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

export async function connectMcp(url: string, token?: string) {
  const client = new Client({ name: "alexa-plus-simulator", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  });
  await client.connect(transport);
  return client;
}

async function call(client: Client, trace: TraceStep[], tool: string, args: Record<string, unknown>) {
  const t0 = Date.now();
  const r = await client.callTool({ name: tool, arguments: args });
  const structured =
    (r.structuredContent as Record<string, unknown> | undefined) ??
    safeJson((r.content as { type: string; text?: string }[])?.find((c) => c.type === "text")?.text);
  trace.push({ tool, args, result: structured, ms: Date.now() - t0 });
  return structured as { speak?: string; [k: string]: unknown };
}

function safeJson(s?: string) {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return { speak: s };
  }
}

export async function runAgent(opts: {
  mcpUrl: string;
  token?: string;
  text: string;
  history?: ChatTurn[];
  persona: "member" | "caregiver";
}): Promise<AgentTurn> {
  const client = await connectMcp(opts.mcpUrl, opts.token);
  try {
    if (bedrockEnabled()) {
      try {
        return await bedrockAgent(client, opts);
      } catch (e) {
        console.error("[agent] Bedrock failed, falling back to router:", (e as Error).message);
      }
    }
    return await routerAgent(client, opts.text, opts.persona);
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------- Bedrock tool-use loop ----------------
async function bedrockAgent(client: Client, opts: { text: string; history?: ChatTurn[]; persona: string }): Promise<AgentTurn> {
  const { tools } = await client.listTools();
  const instructions = client.getInstructions() ?? "";
  const bedrockTools: Tool[] = tools.map((t) => ({
    toolSpec: {
      name: t.name,
      description: (t.description ?? t.title ?? t.name).slice(0, 1000),
      inputSchema: { json: t.inputSchema as Record<string, unknown> as never },
    },
  }));
  const system =
    `You are Alexa+, a voice assistant on an Echo Show in an Indian home. ${
      opts.persona === "caregiver"
        ? "You are speaking with a family caregiver who lives away from their parent."
        : "You are speaking with the elderly member herself."
    } Replies are spoken aloud: 1-3 short sentences, no lists, no markdown, no emojis. ` +
    `Use the CareCircle tools. Server instructions:\n${instructions}`;

  const messages: Message[] = [];
  for (const h of (opts.history ?? []).slice(-6)) messages.push({ role: h.role, content: [{ text: h.text }] });
  messages.push({ role: "user", content: [{ text: opts.text }] });

  const trace: TraceStep[] = [];
  for (let i = 0; i < 6; i++) {
    const r = await converse({ system, messages, tools: bedrockTools });
    const msg = r.output?.message;
    if (!msg) break;
    messages.push(msg);
    const uses = (msg.content ?? []).filter((c) => "toolUse" in c && c.toolUse);
    if (r.stopReason !== "tool_use" || !uses.length) {
      return { reply: textOf(msg.content) || "Okay.", trace, engine: `bedrock:${MODEL_ID}` };
    }
    const results = [];
    for (const u of uses) {
      const tu = u.toolUse!;
      const out = await call(client, trace, tu.name!, (tu.input ?? {}) as Record<string, unknown>);
      results.push({ toolResult: { toolUseId: tu.toolUseId!, content: [{ json: out as never }] } });
    }
    messages.push({ role: "user", content: results });
  }
  return { reply: "Sorry, I got a bit muddled there. Could you say that again?", trace, engine: `bedrock:${MODEL_ID}` };
}

// ---------------- deterministic intent router (offline fallback) ----------------
const WORD_NUM: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

export function parseMood(t: string): number | undefined {
  if (/(terrible|awful|very (bad|low|sad)|depress|hopeless|बहुत (बुरा|उदास))/.test(t)) return 1;
  if (/(lonely|sad|low|not (good|great|well)|bad|unwell|tired|upset|worried|उदास|अकेल|thik nahi|theek nahi)/.test(t)) return 2;
  if (/(okay|ok|alright|so so|so-so|fine|theek|ठीक)/.test(t)) return 3;
  if (/(great|wonderful|excellent|fantastic|very good|बहुत अच्छा|mast)/.test(t)) return 5;
  if (/(good|happy|well|better|अच्छा|accha|chhan)/.test(t)) return 4;
  return undefined;
}

function parsePain(t: string): number | undefined {
  const m = t.match(/pain\D{0,20}(\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten)/) ?? t.match(/(\d{1,2}) out of (10|ten)/);
  if (m) {
    const v = m[1];
    return WORD_NUM[v] ?? Number(v);
  }
  if (/(hurt|pain|ache|दर्द|dard)/.test(t)) return /(lot|very|severe|bad|bahut|बहुत)/.test(t) ? 7 : 4;
  return undefined;
}

async function routerAgent(client: Client, raw: string, persona: string): Promise<AgentTurn> {
  const t = raw.toLowerCase().trim();
  const trace: TraceStep[] = [];
  const say = (reply: string): AgentTurn => ({ reply, trace, engine: "router" });

  // 1. emergencies first
  if (/(need help|help me(?! with)|^help\b|emergency|fell|fallen|fall down|chest pain|can't breathe|cannot breathe|breathless|dizzy|faint|bachao|बचाओ|मदद)/.test(t)) {
    const r = await call(client, trace, "request_help", {
      reason: raw,
      urgency: /(come by|when (you|someone) can|today|soon)/.test(t) && !/(fell|chest|breath|dizzy|faint)/.test(t) ? "soon" : "urgent",
    });
    return say(r.speak ?? "I've alerted the family.");
  }

  // 2. caregiver questions
  if (persona === "caregiver" || /(how is (aai|mom|mum|mother|she)|how's (aai|mom)|digest|update on|report)/.test(t)) {
    if (/(adherence|how many doses|percentage|last week)/.test(t)) {
      const r = await call(client, trace, "get_adherence_report", { days: 7 });
      return say(r.speak ?? "");
    }
    if (/(alert|anything wrong|worry|concern)/.test(t)) {
      const r = await call(client, trace, "get_alerts", {});
      return say(r.speak ?? "");
    }
    if (/(refill|stock|running out|reorder)/.test(t)) {
      const r = await call(client, trace, "refill_status", {});
      return say(r.speak ?? "");
    }
    const tellAai = raw.match(/(?:tell|remind) (?:aai|mom|mum|her|mother)(?: that)? (.+)/i);
    if (tellAai) {
      const r = await call(client, trace, "leave_message_for_member", { from: "Swapnil", text: tellAai[1] });
      return say(r.speak ?? "");
    }
    const lang = /(hindi|हिंदी)/.test(t) ? "hi" : /(marathi|मराठी)/.test(t) ? "mr" : "en";
    const r = await call(client, trace, "get_family_digest", { language: lang });
    return say(r.speak ?? "");
  }

  // 3. sending a message to family
  const tell = raw.match(/(?:tell|message|ask|let) (\w+)(?: know)?(?: that| to)? (.+)/i);
  if (tell && !/^(me|you)$/i.test(tell[1])) {
    const to = /^(everyone|family|all)$/i.test(tell[1]) ? undefined : tell[1];
    const r = await call(client, trace, "send_family_message", { to, text: tell[2] });
    return say(r.speak ?? "");
  }

  // 4. dose logging
  const skipped = /(skip|skipped|didn't take|did not take|won't take|not taking|nahi li|नहीं ली)/.test(t);
  const took = /(took|taken|had my|had the|have taken|le li|li hai|ले ली|घेतली)/.test(t);
  if (skipped || took) {
    const status = skipped ? "skipped" : "taken";
    const reason = skipped ? raw.match(/because (.+)/i)?.[1] : undefined;
    const generic = /(all|morning|evening|night|bedtime|my (tablets|medicines|pills)|medicines|dawai|दवा)/.test(t) && !/(metformin|amlo|atorva|sugar|bp|pressure|cholesterol)/.test(t);
    if (generic) {
      const plan = await call(client, trace, "get_todays_plan", {});
      const due = (plan.dueNow as { medication: string }[]) ?? [];
      if (!due.length) return say(`Nothing is due right now. ${plan.speak ?? ""}`);
      const outs: string[] = [];
      for (const d of due) {
        const r = await call(client, trace, "log_dose", { medication: d.medication, status, reason });
        outs.push(r.speak as string);
      }
      return say(outs.join(" "));
    }
    const r = await call(client, trace, "log_dose", { medication: raw, status, reason, confirmEarly: /(yes|sure|confirm)/.test(t) });
    return say(r.speak ?? "");
  }

  // 5. messages
  if (/(message|any news|anyone (call|write)|sandesh|संदेश)/.test(t)) {
    const r = await call(client, trace, "check_messages", {});
    return say(r.speak ?? "");
  }

  // 6. feelings
  const mood = parseMood(t);
  const pain = parsePain(t);
  if (/(feel|feeling|mood|slept|sleep|lonely|pain|hurt|tired|sad|happy|i'm (good|fine|okay|ok|great|not))/.test(t) && (mood || pain !== undefined)) {
    const args: Record<string, unknown> = { mood: mood ?? (pain && pain >= 6 ? 2 : 3), note: raw };
    if (pain !== undefined) args.pain = pain;
    if (/slept (well|good|great)|good sleep/.test(t)) args.sleptWell = true;
    if (/(didn't|did not|couldn't|could not) sleep|bad sleep|slept badly/.test(t)) args.sleptWell = false;
    const r = await call(client, trace, "record_check_in", args);
    return say(r.speak ?? "");
  }

  // 7. refills
  if (/(refill|running out|how many (pills|tablets)|stock)/.test(t)) {
    const r = await call(client, trace, "refill_status", {});
    return say(r.speak ?? "");
  }

  // 8. morning greeting → routine
  if (/(good morning|suprabhat|सुप्रभात|namaste|नमस्ते)/.test(t)) {
    const plan = await call(client, trace, "get_todays_plan", {});
    const msgs = await call(client, trace, "check_messages", {});
    const hasMsg = (msgs.count as number) > 0;
    return say(`Good morning, Aai! ${plan.speak ?? ""} ${hasMsg ? msgs.speak : ""} How are you feeling today?`.replace(/\s+/g, " "));
  }

  // 9. default: plan
  if (/(what|which|when|do i|did i|medicine|tablet|pill|due|next|plan|schedule|dawai|दवा)/.test(t)) {
    const r = await call(client, trace, "get_todays_plan", {});
    return say(r.speak ?? "");
  }

  return say("I can help with your medicines, messages from family, or how you're feeling. What would you like?");
}
