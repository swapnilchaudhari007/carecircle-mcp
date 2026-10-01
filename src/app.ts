// HTTP app: the MCP endpoint (Streamable HTTP, stateless) + the simulator/dashboard API and static UI.

import express, { type Request, type Response, type NextFunction } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { CareService } from "./care.js";
import { createStore, type Store } from "./store.js";
import { FamilyNotifier, type Notifier } from "./notify.js";
import { buildMcpServer, SERVER_INFO } from "./mcp.js";
import { seedDemo } from "./seed.js";
import { runAgent } from "./agent.js";
import { bedrockEnabled, familyDigest, MODEL_ID } from "./ai.js";
import type { Language } from "./domain.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface AppDeps {
  store?: Store;
  notifier?: Notifier;
  token?: string;
  port?: number;
}

export async function createApp(deps: AppDeps = {}) {
  const store = deps.store ?? createStore();
  const notifier = deps.notifier ?? new FamilyNotifier();
  const care = new CareService(store, notifier);
  const token = deps.token ?? process.env.MCP_AUTH_TOKEN;
  const port = deps.port ?? Number(process.env.PORT ?? 8080);
  await seedDemo(store);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));

  // ---------- MCP endpoint ----------
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  function guard(req: Request, res: Response, next: NextFunction) {
    // DNS-rebinding protection required by the MCP Streamable HTTP spec: validate Origin when present.
    const origin = req.headers.origin;
    if (origin && allowedOrigins.length && !allowedOrigins.includes(origin)) {
      try {
        if (new URL(origin).host !== req.headers.host) return void res.status(403).json(rpcError("Forbidden origin"));
      } catch {
        return void res.status(403).json(rpcError("Bad origin"));
      }
    }
    if (token && req.headers.authorization !== `Bearer ${token}`) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="carecircle"');
      return void res.status(401).json(rpcError("Unauthorized"));
    }
    next();
  }

  app.post("/mcp", guard, async (req, res) => {
    // Stateless mode: a fresh server+transport per request. Scales horizontally on Lambda / App Runner.
    const server = buildMcpServer(care);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("[mcp]", e);
      if (!res.headersSent) res.status(500).json(rpcError("Internal server error"));
    }
  });
  const notAllowed = (_: Request, res: Response) =>
    void res.status(405).set("Allow", "POST").json(rpcError("Method not allowed (stateless server)"));
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  // ---------- simulator / dashboard API ----------
  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
      fn(req, res).catch((e) => res.status(400).json({ error: (e as Error).message }));

  app.get("/healthz", (_req, res) => void res.json({ ok: true, protocol: LATEST_PROTOCOL_VERSION, server: SERVER_INFO }));

  app.get(
    "/api/state",
    wrap(async (_req, res) => {
      const member = await care.member();
      const [plan, alerts, adherence, refills, checkIns, messages, appointments, caregivers, now] = await Promise.all([
        care.todaysPlan(member.id),
        care.safetyScan(member.id),
        care.adherence(member.id, 7),
        care.refillForecast(member.id),
        care.checkIns(member.id),
        care.messages(member.id),
        care.upcomingAppointments(member.id),
        care.caregivers(),
        care.now(),
      ]);
      res.json({
        member,
        caregivers,
        now: now.toISOString(),
        plan,
        alerts,
        adherence,
        refills,
        checkIns: checkIns.slice(-7),
        messages: messages.slice(-8),
        appointments,
        notifications: notifier.recent().slice(0, 12),
        engine: bedrockEnabled() ? `Amazon Bedrock (${MODEL_ID})` : "Offline intent router",
        protocol: LATEST_PROTOCOL_VERSION,
      });
    }),
  );

  app.post(
    "/api/agent",
    wrap(async (req, res) => {
      const { text, history, persona } = req.body ?? {};
      if (!text || typeof text !== "string") throw new Error("text required");
      const turn = await runAgent({
        mcpUrl: process.env.AGENT_MCP_URL ?? `http://127.0.0.1:${port}/mcp`,
        token,
        text: text.slice(0, 500),
        history: Array.isArray(history) ? history.slice(-6) : [],
        persona: persona === "caregiver" ? "caregiver" : "member",
      });
      res.json(turn);
    }),
  );

  app.get(
    "/api/digest",
    wrap(async (req, res) => {
      const lang = (["en", "hi", "mr"].includes(String(req.query.lang)) ? req.query.lang : "en") as Language;
      res.json(await familyDigest(await care.digestData(), lang));
    }),
  );

  app.post(
    "/api/clock",
    wrap(async (req, res) => {
      const now = await care.setClock(req.body?.iso ?? null);
      res.json({ now: now.toISOString() });
    }),
  );

  // Proactive scan — called by EventBridge Scheduler every 30 min in AWS.
  app.post(
    "/api/scan",
    wrap(async (_req, res) => {
      const alerts = await care.safetyScan();
      res.json({ open: alerts.length });
    }),
  );

  app.post(
    "/api/reset",
    wrap(async (_req, res) => {
      await seedDemo(store, new Date(), true);
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/message",
    wrap(async (req, res) => {
      const { from, text } = req.body ?? {};
      if (!text) throw new Error("text required");
      res.json(await care.leaveMessageForMember({ from: from || "Family", text }));
    }),
  );

  app.post(
    "/api/alerts/:id/ack",
    wrap(async (req, res) => {
      res.json(await care.acknowledgeAlert(String(req.params.id)));
    }),
  );

  app.use(express.static(path.resolve(here, "../public"), { extensions: ["html"] }));

  return { app, care, store, notifier };
}

function rpcError(message: string) {
  return { jsonrpc: "2.0", error: { code: -32000, message }, id: null };
}
