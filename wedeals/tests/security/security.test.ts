import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCycle } from "../../src/brain/pipeline";
import { seedDemo } from "../../src/db/seed";
import { buildApp } from "../../src/server/app";
import { tokenMatches } from "../../src/security/auth";
import { TOKEN, makeCtx } from "../helpers";

const auth = { authorization: `Bearer ${TOKEN}` };
const setup = () => {
  const h = makeCtx();
  return { ...h, app: buildApp(h.ctx) };
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe("segurança", () => {
  it("recusa iniciar com ADMIN_TOKEN ausente ou curto", () => {
    expect(() => buildApp(makeCtx({ cfg: { adminToken: "" } }).ctx)).toThrow(/ADMIN_TOKEN/);
    expect(() => buildApp(makeCtx({ cfg: { adminToken: "curto" } }).ctx)).toThrow(/ADMIN_TOKEN/);
  });

  it("todas as rotas /api exigem token (exceto health)", async () => {
    const { app } = setup();
    for (const [method, url] of [
      ["GET", "/api/dashboard"], ["GET", "/api/groups"], ["POST", "/api/groups"], ["POST", "/api/brain/run"],
      ["POST", "/api/offers/import"], ["POST", "/api/commissions/import"], ["GET", "/api/assisted"], ["PUT", "/api/settings/brain"],
    ] as const) {
      const r = await app.inject({ method, url, headers: { authorization: "Bearer errado-errado-errado-errado" } });
      expect(r.statusCode, `${method} ${url}`).toBe(401);
    }
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/dashboard", headers: { authorization: TOKEN } })).statusCode).toBe(401); // sem "Bearer"
  });

  it("bloqueia força bruta após tentativas falhas", async () => {
    const { app } = setup();
    const codes = [];
    for (let i = 0; i < 12; i++) codes.push((await app.inject({ url: "/api/dashboard", headers: { authorization: `Bearer x${i}` } })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it("comparação de token em tempo constante e sem aceitar vazio", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN + "x", TOKEN)).toBe(false);
    expect(tokenMatches("", TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
  });

  it("envia cabeçalhos de segurança (CSP, nosniff, frame)", async () => {
    const { app } = setup();
    const r = await app.inject({ url: "/" });
    expect(r.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-frame-options"]).toBe("DENY");
  });

  it("redirecionador não é open redirect e valida o código", async () => {
    const { app, ctx } = setup();
    seedDemo(ctx);
    await runCycle(ctx);
    expect((await app.inject({ url: "/r/../../etc" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/r/%3Cscript%3E" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/r/naoexiste1" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/r/abc?to=https://evil.com" })).statusCode).toBe(400);
    const pub = ctx.repo.listPublications({ limit: 1 })[0];
    const r = await app.inject({ url: `/r/${pub.trackingCode}?url=https://evil.com` });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(ctx.repo.getOffer(pub.offerId)!.affiliateUrl);
  });

  it("cliques não armazenam dados pessoais (sem IP, telefone ou user-agent)", () => {
    const { ctx } = setup();
    const cols = (ctx.repo.db.prepare("PRAGMA table_info(clicks)").all() as any[]).map((c) => c.name);
    expect(cols.sort()).toEqual(["count", "hour", "tracking_code"]);
    const all = (ctx.repo.db.prepare("SELECT sql FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.sql).join("\n");
    expect(all).not.toMatch(/\b(ip|phone|telefone|user_agent|whatsapp_number|cpf|email)\b/i);
  });

  it("rejeita links javascript:/data: e domínios falsos na importação e vinculação", async () => {
    const { app } = setup();
    const r = (await app.inject({
      method: "POST", url: "/api/offers/import", headers: auth,
      payload: { format: "json", data: [
        { marketplace: "shopee", external_id: "1", title: "abc", url: "javascript:alert(1)", price: "10" },
        { marketplace: "shopee", external_id: "2", title: "abc", url: "https://shopee.com.br/x", affiliate_url: "data:text/html,<script>", price: "10" },
        { marketplace: "shopee", external_id: "3", title: "abc", url: "https://169.254.169.254/latest", price: "10" },
      ] },
    })).json();
    expect(r.imported).toBe(0);
    expect(r.errors).toHaveLength(3);
  });

  it("conteúdo malicioso não é executado: dashboard não usa innerHTML", () => {
    const js = readFileSync(join(__dirname, "../../src/server/public/app.js"), "utf8");
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });

  it("valida e limita entrada (payload inválido → 400, sem stack trace)", async () => {
    const { app } = setup();
    const r = await app.inject({ method: "POST", url: "/api/groups", headers: auth, payload: { name: "<b>x</b>".repeat(50), platform: "whatsapp" } });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toMatch(/at .*\.ts:\d+/);
    const big = await app.inject({ method: "POST", url: "/api/groups/abc/pause", headers: auth });
    expect(big.statusCode).toBe(400);
  });

  it("escopo: não existem módulos proibidos (chatbot, auto-resposta, disparo 1:1, captação, WhatsApp não oficial)", () => {
    const src = walk(join(__dirname, "../../src")).filter((f) => /\.(ts|js)$/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(src).not.toMatch(/from ["'](@whiskeysockets\/baileys|baileys|@wppconnect|whatsapp-web\.js|venom-bot)/);
    expect(src).not.toMatch(/evolution-api|\/message\/sendText/i);
    expect(src).not.toMatch(/addParticipant|groupParticipantsUpdate|scrapeContacts|autoReply|chatbot/i);
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(deps.filter((d) => /baileys|wppconnect|whatsapp|venom/i.test(d))).toEqual([]);
  });

  it("contas: guarda só hash de senha e de sessão, sem dados pessoais além de nome e usuário", async () => {
    const { app, ctx } = setup();
    await app.inject({ method: "POST", url: "/api/users", headers: auth, payload: { username: "seg", displayName: "Seg", role: "operador", password: "senha-provisoria-1" } });
    const { token } = (await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "seg", password: "senha-provisoria-1" } })).json();
    const dump = JSON.stringify([ctx.repo.db.prepare("SELECT * FROM users").all(), ctx.repo.db.prepare("SELECT * FROM sessions").all()]);
    expect(dump).not.toContain("senha-provisoria-1");
    expect(dump).not.toContain(token);
    const cols = (ctx.repo.db.prepare("PRAGMA table_info(users)").all() as any[]).map((c) => c.name);
    expect(cols.sort()).toEqual(["active", "created_at", "display_name", "id", "last_login_at", "must_change_password", "password_hash", "role", "username"]);
    // nenhuma resposta da API devolve o hash
    const list = (await app.inject({ url: "/api/users", headers: auth })).body;
    expect(list).not.toMatch(/scrypt|password_hash|passwordHash/);
  });

  it("AliExpress fora do escopo: banco recusa o marketplace", () => {
    const { ctx } = setup();
    expect(() =>
      ctx.repo.db.prepare("INSERT INTO offers (marketplace, external_id, title, url, price, category, created_at, updated_at) VALUES ('aliexpress','1','x','https://a',1,'x','t','t')").run(),
    ).toThrow(/CHECK/);
  });
});
