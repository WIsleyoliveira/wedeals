import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
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
import { newRecoveryCodes, newTotpSecret, otpauthUri, recoveryCodeHash, verifyTotp } from "../security/totp";

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
  "POST /api/users/:id/mfa/reset",
  "GET /api/settings/security",
  "PUT /api/settings/security",
]);

/** Liberadas mesmo com troca de senha pendente. */
const ALLOWED_WHILE_MUST_CHANGE = new Set(["GET /api/auth/me", "POST /api/auth/password", "POST /api/auth/logout"]);
/** Liberadas enquanto a pessoa ainda precisa ativar a verificação em duas etapas obrigatória. */
const ALLOWED_WHILE_MFA_SETUP = new Set([...ALLOWED_WHILE_MUST_CHANGE, "POST /api/auth/mfa/setup", "POST /api/auth/mfa/enable"]);
const PUBLIC_API = new Set(["GET /api/health", "POST /api/auth/login", "POST /api/auth/login/mfa"]);

export interface SecurityPolicy {
  /** Exige verificação em duas etapas de administradores. */
  requireMfaForAdmins: boolean;
  /** Exige de todas as contas. */
  requireMfaForAll: boolean;
}
export const SECURITY_KEY = "security.policy";
const DEFAULT_POLICY: SecurityPolicy = { requireMfaForAdmins: false, requireMfaForAll: false };
const MFA_ISSUER = "WeDeals WAPE";
const MFA_CHALLENGE_MS = 5 * 60_000;
const MFA_MAX_ATTEMPTS = 5;

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
  const policy = (): SecurityPolicy => ({ ...DEFAULT_POLICY, ...repo.getSetting<Partial<SecurityPolicy>>(SECURITY_KEY, {}) });
  const mfaRequiredFor = (role: Role) => policy().requireMfaForAll || (role === "admin" && policy().requireMfaForAdmins);
  // desafio entre a senha e o código: em memória (reiniciar o app só obriga a digitar a senha de novo)
  const challenges = new Map<string, { userId: number; username: string; expiresAt: number; attempts: number }>();

  const startSession = (u: User, at: Date, detail: unknown = null) => {
    const { token, hash } = newSessionToken();
    const expiresAt = new Date(at.getTime() + SESSION_HOURS * 3_600_000);
    repo.createSession(hash, u.id, at, expiresAt);
    repo.audit("auth.login", detail, at, u.username);
    return { token, expiresAt: expiresAt.toISOString(), user: repo.getUser(u.id)! };
  };

  /** Confere código do app (sem reuso) ou código de recuperação (uso único). */
  const checkSecondFactor = (userId: number, code: string, at: Date): "totp" | "recovery" | null => {
    const m = repo.getMfa(userId);
    if (!m?.enabled || !m.secret) return null;
    if (/^\s*\d{3}\s?\d{3}\s*$/.test(code)) {
      const step = verifyTotp(m.secret, code, at, m.lastStep);
      if (step === null) return null;
      repo.setMfaLastStep(userId, step);
      return "totp";
    }
    return repo.useRecoveryCode(userId, recoveryCodeHash(code), at) ? "recovery" : null;
  };

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
    if (req.actor.user && !req.actor.user.mfaEnabled && mfaRequiredFor(req.actor.role) && !ALLOWED_WHILE_MFA_SETUP.has(key))
      return reply.code(403).send({ error: "ative a verificação em duas etapas para continuar", code: "mfa_setup_required" });
    if (ADMIN_ONLY.has(key) && req.actor.role !== "admin") return reply.code(403).send({ error: "só administradores" });
  });

  // Registro de quem alterou o quê (sem o corpo da requisição: pode conter senhas ou dados importados)
  app.addHook("onResponse", async (req, reply) => {
    if (!req.actor || req.method === "GET" || !req.url.startsWith("/api/")) return;
    const key = routeKey(req);
    if (["POST /api/auth/login", "POST /api/auth/login/mfa", "POST /api/auth/logout"].includes(key)) return; // já registrados
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
    if (u.mfaEnabled) {
      // senha certa: falta o código do app (o desafio vale 5 minutos e 5 tentativas)
      const mfaToken = randomBytes(24).toString("base64url");
      challenges.set(mfaToken, { userId: u.id, username: u.username, expiresAt: now().getTime() + MFA_CHALLENGE_MS, attempts: 0 });
      for (const [k, c] of challenges) if (c.expiresAt < now().getTime()) challenges.delete(k);
      return { mfaRequired: true, mfaToken };
    }
    return startSession(u, now());
  });

  app.post("/api/auth/login/mfa", async (req, reply) => {
    const b = z.object({ mfaToken: z.string().max(64), code: z.string().trim().min(6).max(20) }).parse(req.body);
    const c = challenges.get(b.mfaToken);
    if (!c || c.expiresAt < now().getTime()) {
      challenges.delete(b.mfaToken);
      return reply.code(401).send({ error: "o tempo para digitar o código acabou; entre de novo", code: "mfa_expired" });
    }
    if (perUserFail.blocked(c.username) || authFailLimiter.blocked(req.ip))
      return reply.code(429).send({ error: "muitas tentativas; aguarde alguns minutos" });
    const method = checkSecondFactor(c.userId, b.code, now());
    const u = repo.getUser(c.userId);
    if (!method || !u?.active) {
      c.attempts++;
      perUserFail.allow(c.username);
      authFailLimiter.allow(req.ip);
      repo.audit("auth.mfa_failed", { username: c.username }, now());
      if (c.attempts >= MFA_MAX_ATTEMPTS) {
        challenges.delete(b.mfaToken);
        return reply.code(429).send({ error: "muitas tentativas; entre de novo", code: "mfa_expired" });
      }
      return reply.code(401).send({ error: "código inválido" });
    }
    challenges.delete(b.mfaToken);
    const out = startSession(u, now(), { mfa: method });
    return method === "recovery" ? { ...out, recoveryCodesLeft: repo.recoveryCodesLeft(u.id) } : out;
  });

  app.post("/api/auth/logout", async (req) => {
    if (req.actor?.sessionHash) repo.deleteSession(req.actor.sessionHash);
    repo.audit("auth.logout", null, now(), req.actor!.name);
    return { ok: true };
  });

  app.get("/api/auth/me", async (req) => {
    const a = req.actor!;
    return a.user
      ? { kind: a.kind, user: a.user, mfa: { required: mfaRequiredFor(a.user.role), recoveryCodesLeft: a.user.mfaEnabled ? repo.recoveryCodesLeft(a.user.id) : 0 } }
      : { kind: a.kind, user: { id: 0, username: TOKEN_ACTOR, displayName: "Token de administrador", role: "admin", active: true, mustChangePassword: false, mfaEnabled: false }, mfa: { required: false, recoveryCodesLeft: 0 } };
  });

  // ---------- Verificação em duas etapas da própria conta ----------
  const sessionUser = (req: FastifyRequest, reply: FastifyReply) => {
    const u = req.actor!.user;
    if (!u) reply.code(400).send({ error: "o token de administrador não usa verificação em duas etapas" });
    return u;
  };

  app.post("/api/auth/mfa/setup", async (req, reply) => {
    const u = sessionUser(req, reply);
    if (!u) return;
    if (u.mfaEnabled) return reply.code(409).send({ error: "a verificação em duas etapas já está ativa" });
    const secret = newTotpSecret();
    repo.setPendingMfa(u.id, secret);
    const uri = otpauthUri(secret, u.username, MFA_ISSUER);
    const qrSvg = await QRCode.toString(uri, { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#0a1630", light: "#ffffff" } });
    return { secret, otpauthUri: uri, qrSvg };
  });

  app.post("/api/auth/mfa/enable", async (req, reply) => {
    const u = sessionUser(req, reply);
    if (!u) return;
    const { code } = z.object({ code: z.string().trim().max(10) }).parse(req.body);
    const pending = repo.getMfa(u.id)?.pendingSecret;
    if (!pending) return reply.code(400).send({ error: "gere o QR code primeiro" });
    const step = verifyTotp(pending, code, now());
    if (step === null) {
      if (!authFailLimiter.allow(req.ip)) return reply.code(429).send({ error: "muitas tentativas" });
      return reply.code(400).send({ error: "código incorreto; confira se o relógio do celular está certo" });
    }
    const codes = newRecoveryCodes();
    repo.enableMfa(u.id, pending, step, codes.map(recoveryCodeHash));
    repo.deleteUserSessions(u.id, req.actor!.sessionHash); // outras sessões entraram só com senha
    repo.audit("auth.mfa_enabled", null, now(), u.username);
    return { ok: true, recoveryCodes: codes };
  });

  app.post("/api/auth/mfa/recovery-codes", async (req, reply) => {
    const u = sessionUser(req, reply);
    if (!u) return;
    const { code } = z.object({ code: z.string().trim().max(10) }).parse(req.body);
    const m = repo.getMfa(u.id);
    if (!m?.enabled || !m.secret) return reply.code(400).send({ error: "a verificação em duas etapas não está ativa" });
    const step = verifyTotp(m.secret, code, now(), m.lastStep);
    if (step === null) {
      if (!authFailLimiter.allow(req.ip)) return reply.code(429).send({ error: "muitas tentativas" });
      return reply.code(400).send({ error: "código incorreto" });
    }
    repo.setMfaLastStep(u.id, step);
    const codes = newRecoveryCodes();
    repo.replaceRecoveryCodes(u.id, codes.map(recoveryCodeHash));
    repo.audit("auth.recovery_codes_regenerated", null, now(), u.username);
    return { recoveryCodes: codes };
  });

  app.post("/api/auth/mfa/disable", async (req, reply) => {
    const u = sessionUser(req, reply);
    if (!u) return;
    const b = z.object({ password: z.string().max(PASSWORD_MAX), code: z.string().trim().max(20) }).parse(req.body);
    if (mfaRequiredFor(u.role)) return reply.code(400).send({ error: "a verificação em duas etapas é obrigatória para o seu papel" });
    const passOk = await verifyPassword(b.password, repo.getPasswordHash(u.id)!);
    if (!passOk || !checkSecondFactor(u.id, b.code, now())) {
      if (!authFailLimiter.allow(req.ip)) return reply.code(429).send({ error: "muitas tentativas" });
      return reply.code(400).send({ error: "senha ou código incorreto" });
    }
    repo.disableMfa(u.id);
    repo.audit("auth.mfa_disabled", null, now(), u.username);
    return { ok: true };
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

  app.post("/api/users/:id/mfa/reset", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const u = repo.getUser(id);
    if (!u) return reply.code(404).send({ error: "usuário não encontrado" });
    // para quem perdeu o celular e os códigos de recuperação: a pessoa ativa de novo no próximo acesso
    repo.disableMfa(id);
    repo.deleteUserSessions(id);
    return { ok: true };
  });

  app.get("/api/settings/security", async () => policy());
  app.put("/api/settings/security", async (req, reply) => {
    const b = z.object({ requireMfaForAdmins: z.boolean(), requireMfaForAll: z.boolean() }).partial().parse(req.body);
    const next = { ...policy(), ...b };
    const me = req.actor!.user;
    // evita que o admin trave a si mesmo: ative na própria conta antes de exigir dos outros
    if (me && !me.mfaEnabled && (next.requireMfaForAll || (me.role === "admin" && next.requireMfaForAdmins)))
      return reply.code(400).send({ error: "ative a verificação em duas etapas na sua conta antes de exigir" });
    repo.setSetting(SECURITY_KEY, next);
    return policy();
  });

  app.get("/api/activity", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200), actor: z.string().max(64).optional() }).parse(req.query);
    return repo.listAudit(q);
  });
}
