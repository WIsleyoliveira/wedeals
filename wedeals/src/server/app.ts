import Fastify, { type FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { dashboardMetrics, importCommissions } from "../analytics/metrics";
import { commercialInsights } from "../brain/insights";
import { DEFAULT_BOUNDS, currentWeights, type LearningBounds } from "../brain/learning";
import {
  brainSettings,
  confirmAssistedPublication,
  distributeOffer,
  runCycle,
  AI_STATUS_KEY,
  type AiStatus,
  type BrainContext,
  type BrainSettings,
} from "../brain/pipeline";
import { MARKETPLACES } from "../domain/types";
import { parseHHMM } from "../groups/rules";
import { importOffers, linkAffiliateUrl, parseCsv } from "../links/importer";
import { parseHttpsUrl } from "../links/validation";
import { MIN_TOKEN_LENGTH, RateLimiter } from "../security/auth";
import { registerAuth } from "./users";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
};
const MIME: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };

const hhmm = z.string().refine((s) => {
  try {
    parseHHMM(s);
    return true;
  } catch {
    return false;
  }
}, "use HH:MM");

const GroupSchema = z.object({
  name: z.string().trim().min(2).max(100),
  platform: z.enum(["whatsapp", "telegram"]),
  inviteLink: z
    .string()
    .max(500)
    .nullable()
    .default(null)
    .refine((v) => v === null || parseHttpsUrl(v).ok, "link de convite deve ser https"),
  externalId: z.string().max(100).nullable().default(null),
  admins: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  categories: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
  marketplaces: z.array(z.enum(MARKETPLACES)).default([]),
  audience: z.number().int().min(0).max(10_000_000).nullable().default(null),
  audienceSource: z.enum(["informed", "official"]).nullable().default(null),
  windowStart: hhmm.default("08:00"),
  windowEnd: hhmm.default("22:00"),
  minIntervalMinutes: z.number().int().min(5).max(1440).default(30),
  maxDailyPosts: z.number().int().min(1).max(200).default(20),
  minDealScore: z.number().min(0).max(100).default(60),
  template: z.string().max(2000).nullable().default(null),
  affiliateAccount: z.string().max(100).nullable().default(null),
  mode: z.enum(["assisted", "automatic"]).default("assisted"),
  status: z.enum(["active", "paused"]).default("active"),
  repostCooldownDays: z.number().int().min(1).max(365).default(7),
});

const IdParam = z.object({ id: z.coerce.number().int().positive() });

export interface AppOps {
  /** Alertas operacionais (opcional): estado atual e envio de teste pelo dashboard/API. */
  alerts?: {
    channels: string[];
    active: () => { key: string; since: string; lastSentAt: string | null; message: string }[];
    test: () => Promise<void>;
    /** Roda uma verificação agora (a mesma que o monitor faz a cada 5 min). */
    check: () => Promise<void>;
  };
}

export function buildApp(ctx: BrainContext, ops: AppOps = {}): FastifyInstance {
  if (!ctx.cfg.adminToken || ctx.cfg.adminToken.length < MIN_TOKEN_LENGTH) {
    throw new Error(`ADMIN_TOKEN ausente ou curto (mínimo ${MIN_TOKEN_LENGTH} caracteres)`);
  }
  const app = Fastify({
    logger: false,
    bodyLimit: 5 * 1024 * 1024,
    // confia só nos N saltos de proxy configurados (ex.: Caddy); sem proxy, X-Forwarded-For é ignorado
    trustProxy: ctx.cfg.trustProxyHops > 0 ? (_addr: string, hop: number) => hop < ctx.cfg.trustProxyHops : false,
  });
  const apiLimiter = new RateLimiter(300, 60_000);
  const authFailLimiter = new RateLimiter(10, 15 * 60_000);
  const redirectLimiter = new RateLimiter(120, 60_000);
  const now = () => ctx.clock();
  const { repo } = ctx;

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header(
      "content-security-policy",
      "default-src 'self'; img-src 'self' https: data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    return payload;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: "dados inválidos", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const status = (err as any).statusCode && (err as any).statusCode < 500 ? (err as any).statusCode : 500;
    return reply.code(status).send({ error: status === 500 ? "erro interno" : (err as Error).message });
  });

  // Limite geral por IP; autenticação, papéis e auditoria ficam em registerAuth (users.ts)
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url === "/api/health") return;
    if (!apiLimiter.allow(req.ip)) return reply.code(429).send({ error: "muitas requisições" });
  });
  registerAuth(app, ctx, authFailLimiter);

  // ---------- Público ----------
  for (const [route, file] of Object.entries(STATIC)) {
    app.get(route, async (_req, reply) => {
      const ext = file.split(".").pop()!;
      return reply.type(MIME[ext]).send(readFileSync(join(PUBLIC_DIR, file)));
    });
  }

  app.get("/api/health", async () => ({ ok: true, publishEnabled: ctx.cfg.publishEnabled }));

  /** Redirecionador rastreável: conta clique agregado e envia ao link OFICIAL armazenado (sem open redirect). */
  app.get("/r/:code", async (req, reply) => {
    const { code } = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{6,16}$/) }).parse(req.params);
    if (!redirectLimiter.allow(req.ip)) return reply.code(429).send("muitas requisições");
    const pub = repo.findPublicationByCode(code);
    const offer = pub ? repo.getOffer(pub.offerId) : undefined;
    if (!pub || !offer?.affiliateUrl) return reply.code(404).type("text/plain").send("oferta não encontrada");
    repo.incrementClick(code, now());
    reply.header("cache-control", "no-store");
    return reply.redirect(offer.affiliateUrl, 302);
  });

  // ---------- Dashboard / inteligência ----------
  app.get("/api/dashboard", async () => dashboardMetrics(repo, now()));
  app.get("/api/insights", async () => ({ ...commercialInsights(repo), weights: currentWeights(repo) }));
  app.get("/api/agents", async () => repo.listAgentRuns());
  const alertsView = () => {
    // histórico: cada verificação que mudou algo vira uma ou mais linhas (novo, continua, resolvido, falha de envio)
    const history = repo.listAudit({ actions: ["alerts.update", "alerts.test"], limit: 100 }).flatMap((e) => {
      const d = (e.detail ?? {}) as { source?: string; events?: { type: string; message: string }[]; delivered?: boolean; sendError?: string };
      if (e.action === "alerts.test") return [{ at: e.at, type: "teste", message: "Alerta de teste enviado", source: e.actor ?? "sistema", delivered: true }];
      const rows = (d.events ?? []).map((ev) => ({ at: e.at, type: ev.type, message: ev.message, source: d.source ?? "monitor", delivered: Boolean(d.delivered) }));
      if (d.sendError) rows.push({ at: e.at, type: "falha_envio", message: d.sendError, source: d.source ?? "monitor", delivered: false });
      return rows;
    });
    return {
      channels: ops.alerts?.channels ?? [],
      monitoring: Boolean(ops.alerts),
      active: ops.alerts?.active() ?? [],
      lastCheckAt: repo.getSetting<string | null>("alerts.lastCheckAt", null),
      history: history.slice(0, 100),
    };
  };
  app.get("/api/alerts", async () => alertsView());
  app.post("/api/alerts/check", async (_req, reply) => {
    if (!ops.alerts) return reply.code(409).send({ error: "monitor de alertas não está ativo neste processo" });
    await ops.alerts.check();
    return alertsView();
  });
  app.post("/api/alerts/test", async (req, reply) => {
    if (!ops.alerts?.channels.length)
      return reply.code(409).send({ error: "nenhum canal de alerta configurado (ALERT_TELEGRAM_CHAT_ID ou ALERT_WEBHOOK_URL)" });
    try {
      await ops.alerts.test();
      repo.audit("alerts.test", { channels: ops.alerts.channels }, now(), req.actor?.name ?? null);
      return { ok: true, channels: ops.alerts.channels };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
  app.get("/api/integrations", async () => ({
    publishEnabled: ctx.cfg.publishEnabled,
    marketplaces: MARKETPLACES.map((m) => ctx.adapters[m].status()),
    channels: [
      ...ctx.router.list(),
      { id: "whatsapp_unofficial", official: false, automatic: true, enabled: false, note: "Não implementado — requer aprovação expressa da WAPE" },
    ],
    telegramConfigured: Boolean(ctx.cfg.telegramBotToken),
    ai: {
      provider: ctx.ai.name,
      model: ctx.ai.model ?? null,
      status: repo.getSetting<AiStatus | null>(AI_STATUS_KEY, null),
      today: Object.fromEntries(["ai_hooks", "ai_fallback", "ai_rejected", "ai_unavailable"].map((m) => [m.replace("ai_", ""), repo.counterOnDay(m, now())])),
    },
    quotas: ctx.quotas.snapshot(now()),
  }));

  // ---------- Ofertas ----------
  app.get("/api/offers", async (req) => {
    const q = z
      .object({
        status: z.enum(["discovered", "awaiting_link", "approved", "rejected", "queued", "published", "expired"]).optional(),
        marketplace: z.enum(MARKETPLACES).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    return repo.listOffers(q);
  });

  app.post("/api/offers/import", async (req) => {
    const b = z
      .object({ format: z.enum(["csv", "json"]), data: z.union([z.string().max(5_000_000), z.array(z.record(z.string(), z.unknown())).max(5000)]) })
      .parse(req.body);
    const rows = b.format === "csv" ? parseCsv(String(b.data)) : (b.data as Record<string, unknown>[]);
    const r = importOffers(repo, rows, now(), ctx.cfg.affiliateExtraDomains);
    repo.audit("offers.import", { imported: r.imported, errors: r.errors.length }, now());
    return r;
  });

  app.post("/api/offers/:id/link", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const { url } = z.object({ url: z.string().max(2000) }).parse(req.body);
    const r = linkAffiliateUrl(repo, id, url, now(), ctx.cfg.affiliateExtraDomains);
    return r.ok ? r : reply.code(400).send({ error: r.error });
  });

  app.post("/api/offers/:id/reject", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    if (!repo.getOffer(id)) return reply.code(404).send({ error: "oferta não encontrada" });
    repo.updateOfferEvaluation(id, { status: "rejected", rejectReason: "rejeitada pelo administrador" }, now());
    repo.audit("offer.rejected_by_admin", { id }, now());
    return { ok: true };
  });

  app.post("/api/offers/:id/distribute", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const { groupIds } = z.object({ groupIds: z.array(z.number().int().positive()).min(1).max(200) }).parse(req.body);
    const r = await distributeOffer(ctx, id, groupIds);
    return r.ok ? r : reply.code(400).send({ error: r.error });
  });

  // ---------- Grupos ----------
  app.get("/api/groups", async () => repo.listGroups());
  app.post("/api/groups", async (req, reply) => {
    const g = GroupSchema.parse(req.body);
    const created = repo.createGroup(g, now());
    repo.audit("group.created", { id: created.id }, now());
    return reply.code(201).send(created);
  });
  app.patch("/api/groups/:id", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const patch = GroupSchema.partial().parse(req.body);
    // remove defaults aplicados pelo partial (só campos enviados)
    const sent = Object.fromEntries(Object.entries(patch).filter(([k]) => k in (req.body as object)));
    const g = repo.updateGroup(id, sent);
    if (!g) return reply.code(404).send({ error: "grupo não encontrado" });
    repo.audit("group.updated", { id, fields: Object.keys(sent) }, now());
    return g;
  });
  for (const action of ["pause", "resume"] as const) {
    app.post(`/api/groups/:id/${action}`, async (req, reply) => {
      const { id } = IdParam.parse(req.params);
      const g = repo.updateGroup(id, { status: action === "pause" ? "paused" : "active" });
      if (!g) return reply.code(404).send({ error: "grupo não encontrado" });
      repo.audit(`group.${action}`, { id }, now());
      return g;
    });
  }
  app.get("/api/groups/:id/publications", async (req) => {
    const { id } = IdParam.parse(req.params);
    return repo.listPublications({ groupId: id, limit: 200 });
  });

  // ---------- Publicações / central assistida ----------
  app.get("/api/publications", async (req) => {
    const q = z
      .object({ status: z.enum(["scheduled", "ready_for_admin", "published", "skipped", "failed", "dry_run"]).optional() })
      .parse(req.query);
    return repo.listPublications({ statuses: q.status ? [q.status] : undefined, limit: 300 });
  });

  app.get("/api/assisted", async () =>
    repo.listPublications({ statuses: ["ready_for_admin"], limit: 100 }).map((p) => {
      const g = repo.getGroup(p.groupId)!;
      const o = repo.getOffer(p.offerId)!;
      return { ...p, groupName: g.name, groupInviteLink: g.inviteLink, platform: g.platform, offerTitle: o.title, marketplace: o.marketplace };
    }),
  );

  app.post("/api/publications/:id/confirm", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const r = confirmAssistedPublication(repo, id, now());
    return r.ok ? r : reply.code(400).send({ error: r.error });
  });
  app.post("/api/publications/:id/skip", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    if (!repo.getPublication(id)) return reply.code(404).send({ error: "publicação não encontrada" });
    repo.updatePublication(id, "skipped", { error: "descartada pelo administrador" });
    return { ok: true };
  });

  // ---------- Comissões e custos ----------
  app.post("/api/commissions/import", async (req) => {
    const b = z
      .object({ format: z.enum(["csv", "json"]), data: z.union([z.string().max(5_000_000), z.array(z.record(z.string(), z.unknown())).max(20000)]) })
      .parse(req.body);
    const rows = b.format === "csv" ? parseCsv(String(b.data)) : (b.data as Record<string, unknown>[]);
    const r = importCommissions(repo, rows);
    repo.audit("commissions.import", { imported: r.imported }, now());
    return r;
  });
  app.post("/api/costs", async (req, reply) => {
    const c = z
      .object({
        category: z.enum(["infraestrutura", "ia", "api", "ferramentas", "pessoas", "outros"]),
        description: z.string().trim().min(2).max(200),
        amount: z.number().min(0).max(10_000_000),
        occurredAt: z.string().refine((s) => !Number.isNaN(Date.parse(s))).optional(),
      })
      .parse(req.body);
    repo.addCost({ ...c, occurredAt: c.occurredAt ?? now().toISOString() });
    return reply.code(201).send({ ok: true });
  });

  // ---------- Mega Brain ----------
  app.post("/api/brain/run", async () => runCycle(ctx));
  app.get("/api/settings/brain", async () => brainSettings(repo));
  app.put("/api/settings/brain", async (req) => {
    const s = z
      .object({
        minScore: z.number().min(0).max(100),
        minSellerReputation: z.number().min(0).max(1),
        maxPriceIncreaseOnRevalidation: z.number().min(0).max(0.5),
        keywords: z.object(Object.fromEntries(MARKETPLACES.map((m) => [m, z.array(z.string().trim().min(2).max(60)).max(50)])) as any),
        searchLimit: z.number().int().min(1).max(50),
      })
      .partial()
      .parse(req.body) as Partial<BrainSettings>;
    repo.setSetting("brain.settings", { ...repo.getSetting("brain.settings", {}), ...s });
    repo.audit("settings.brain", Object.keys(s), now());
    return brainSettings(repo);
  });
  app.get("/api/settings/learning-bounds", async () => repo.getSetting<LearningBounds>("learning.bounds", DEFAULT_BOUNDS));
  app.put("/api/settings/learning-bounds", async (req) => {
    const b = z
      .object({
        min: z.number().min(0).max(1),
        max: z.number().min(0).max(1),
        maxStep: z.number().min(0).max(0.5),
        minPublications: z.number().int().min(1).max(1000),
      })
      .refine((v) => v.min <= v.max, "min deve ser <= max")
      .parse(req.body);
    repo.setSetting("learning.bounds", b);
    return b;
  });

  return app;
}
