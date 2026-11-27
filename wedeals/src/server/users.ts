import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { BrainContext } from "../brain/pipeline";
import { ROLES, type Role, type User } from "../domain/types";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  RateLimiter,
  SESSION_HOURS,
  bearer,
  dummyPasswordHash,
  hashPassword,
  newSessionToken,
  sessionTokenHash,
  tokenMatches,
  verifyPassword,
} from "../security/auth";

/** Quem fez a requisição. O ADMIN_TOKEN continua valendo como acesso de emergência e para scripts. */
export interface Actor {
  kind: "session" | "token";
  /** Gravado na auditoria: o nome de usuário, ou "token-admin". */
  name: string;
  role: Role;
  user?: User;
  sessionHash?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    actor?: Actor;
  }
}

export const TOKEN_ACTOR = "token-admin";

/** Rotas só para administradores (as demais valem para qualquer pessoa autenticada). */
const ADMIN_ONLY = new Set([
  "POST /api/groups",
  "PATCH /api/groups/:id",
  "POST /api/costs",
  "POST /api/commissions/import",
  "PUT /api/settings/brain",
  "PUT /api/settings/learning-bounds",
  "POST /api/alerts/test",
  "GET /api/users",
  "POST /api/users",
  "PATCH /api/users/:id",
  "POST /api/users/:id/password",
  "GET /api/activity",
]);

/** Liberadas mesmo com troca de senha pendente. */
const ALLOWED_WHILE_MUST_CHANGE = new Set(["GET /api/auth/me", "POST /api/auth/password", "POST /api/auth/logout"]);
const PUBLIC_API = new Set(["GET /api/health", "POST /api/auth/login"]);

const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,32}$/, "use 3 a 32 caracteres: letras minúsculas, números, ponto, hífen ou sublinhado");
const DisplayName = z.string().trim().min(2).max(60);
const Password = z.string().min(PASSWORD_MIN, `mínimo de ${PASSWORD_MIN} caracteres`).max(PASSWORD_MAX);
const IdParam = z.object({ id: z.coerce.number().int().positive() });

const routeKey = (req: FastifyRequest) => `${req.method} ${req.routeOptions.url ?? req.url.split("?")[0]}`;

export function registerAuth(app: FastifyInstance, ctx: BrainContext, authFailLimiter: RateLimiter) {
  const { repo } = ctx;
  const now = () => ctx.clock();
  // além do limite por IP: no máximo 5 senhas erradas por conta a cada 15 min, de qualquer IP
  const perUserFail = new RateLimiter(5, 15 * 60_000);

  const deny = (req: FastifyRequest, reply: FastifyReply) => {
    // só falhas contam para o bloqueio por força bruta
    if (!authFailLimiter.allow(req.ip)) return reply.code(429).send({ error: "muitas tentativas" });
    repo.audit("auth.denied", { url: req.url.slice(0, 100) }, now());
    return reply.code(401).send({ error: "não autorizado" });
  };

  // Autenticação e permissão de todas as rotas /api
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/")) return;
    const key = routeKey(req);
    if (PUBLIC_API.has(key)) return;

    const provided = bearer(req.headers.authorization);
    if (provided && tokenMatches(provided, ctx.cfg.adminToken)) {
      req.actor = { kind: "token", name: TOKEN_ACTOR, role: "admin" };
    } else if (provided?.startsWith("wds_")) {
      const hash = sessionTokenHash(provided);
      const u = repo.findSession(hash, now());
      if (u) req.actor = { kind: "session", name: u.username, role: u.role, user: u, sessionHash: hash };
    }
    if (!req.actor) return deny(req, reply);

    if (req.actor.user?.mustChangePassword && !ALLOWED_WHILE_MUST_CHANGE.has(key))
      return reply.code(403).send({ error: "troque a senha antes de continuar", code: "must_change_password" });
    if (ADMIN_ONLY.has(key) && req.actor.role !== "admin") return reply.code(403).send({ error: "só administradores" });
  });

  // Registro de quem alterou o quê (sem o corpo da requisição: pode conter senhas ou dados importados)
  app.addHook("onResponse", async (req, reply) => {
    if (!req.actor || req.method === "GET" || !req.url.startsWith("/api/")) return;
    const key = routeKey(req);
    if (key === "POST /api/auth/login" || key === "POST /api/auth/logout") return; // já registrados
    const params = (req.params ?? {}) as Record<string, unknown>;
    repo.audit("api", { route: key, ...(params.id ? { id: params.id } : {}), status: reply.statusCode }, now(), req.actor.name);
  });

  // ---------- Sessão ----------
  app.post("/api/auth/login", async (req, reply) => {
    const body = z.object({ username: z.string().trim().toLowerCase().max(64), password: z.string().max(PASSWORD_MAX) }).parse(req.body);
    if (perUserFail.blocked(body.username) || authFailLimiter.blocked(req.ip))
      return reply.code(429).send({ error: "muitas tentativas; aguarde alguns minutos" });
    const u = repo.findUserForLogin(body.username);
    const ok = u ? await verifyPassword(body.password, u.passwordHash) : (await verifyPassword(body.password, await dummyPasswordHash()), false);
    if (!ok || !u || !u.active) {
      const ipOk = authFailLimiter.allow(req.ip);
      const userOk = perUserFail.allow(body.username);
      repo.audit("auth.login_failed", { username: body.username.slice(0, 32) }, now());
      if (!ipOk || !userOk) return reply.code(429).send({ error: "muitas tentativas; aguarde alguns minutos" });
      return reply.code(401).send({ error: "usuário ou senha inválidos" });
    }
    const { token, hash } = newSessionToken();
    const expiresAt = new Date(now().getTime() + SESSION_HOURS * 3_600_000);
    repo.createSession(hash, u.id, now(), expiresAt);
    repo.audit("auth.login", null, now(), u.username);
    const { passwordHash: _, ...user } = u;
    return { token, expiresAt: expiresAt.toISOString(), user };
  });

  app.post("/api/auth/logout", async (req) => {
    if (req.actor?.sessionHash) repo.deleteSession(req.actor.sessionHash);
    repo.audit("auth.logout", null, now(), req.actor!.name);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    const a = req.actor!;
    return a.user
      ? { kind: a.kind, user: a.user }
      : { kind: a.kind, user: { id: 0, username: TOKEN_ACTOR, displayName: "Token de administrador", role: "admin", active: true, mustChangePassword: false } };
  });

  app.post("/api/auth/password", async (req, reply) => {
    const a = req.actor!;
    if (!a.user) return reply.code(400).send({ error: "o token de administrador não tem senha; troque o ADMIN_TOKEN no servidor" });
    const b = z.object({ currentPassword: z.string().max(PASSWORD_MAX), newPassword: Password }).parse(req.body);
    const stored = repo.getPasswordHash(a.user.id)!;
    if (!(await verifyPassword(b.currentPassword, stored))) {
      if (!authFailLimiter.allow(req.ip)) return reply.code(429).send({ error: "muitas tentativas" });
      return reply.code(400).send({ error: "senha atual incorreta" });
    }
    if (b.newPassword === b.currentPassword) return reply.code(400).send({ error: "a nova senha precisa ser diferente da atual" });
    repo.setPassword(a.user.id, await hashPassword(b.newPassword), false);
    repo.deleteUserSessions(a.user.id, a.sessionHash); // encerra as outras sessões
    return { ok: true };
  });

  // ---------- Gestão de usuários (admin) ----------
  app.get("/api/users", async () => repo.listUsers());

  app.post("/api/users", async (req, reply) => {
    const b = z
      .object({ username: Username, displayName: DisplayName, role: z.enum(ROLES), password: Password })
      .parse(req.body);
    if (repo.findUserForLogin(b.username)) return reply.code(409).send({ error: "nome de usuário já existe" });
    // senha inicial é provisória: a pessoa troca no primeiro acesso
    const u = repo.createUser({ username: b.username, displayName: b.displayName, role: b.role, passwordHash: await hashPassword(b.password), mustChangePassword: true }, now());
    return reply.code(201).send(u);
  });

  app.patch("/api/users/:id", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = z.object({ displayName: DisplayName, role: z.enum(ROLES), active: z.boolean() }).partial().parse(req.body);
    const cur = repo.getUser(id);
    if (!cur) return reply.code(404).send({ error: "usuário não encontrado" });
    const self = req.actor!.user?.id === id;
    if (self && (b.active === false || b.role === "operador")) return reply.code(400).send({ error: "você não pode desativar nem rebaixar a própria conta" });
    const losesAdmin = cur.role === "admin" && cur.active && (b.role === "operador" || b.active === false);
    if (losesAdmin && repo.countActiveAdmins() <= 1) return reply.code(400).send({ error: "é preciso manter pelo menos um administrador ativo" });
    const u = repo.updateUser(id, b);
    if (b.active === false || b.role) repo.deleteUserSessions(id); // vale na hora, não no fim da sessão
    return u;
  });

  app.post("/api/users/:id/password", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = z.object({ password: Password }).parse(req.body);
    if (!repo.getUser(id)) return reply.code(404).send({ error: "usuário não encontrado" });
    repo.setPassword(id, await hashPassword(b.password), true);
    repo.deleteUserSessions(id);
    return { ok: true };
  });

  app.get("/api/activity", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200), actor: z.string().max(64).optional() }).parse(req.query);
    return repo.listAudit(q);
  });
}
