import { describe, expect, it } from "vitest";
import { base32Decode, hotp, totpStep } from "../../src/security/totp";
import { buildApp } from "../../src/server/app";
import { TOKEN, makeCtx } from "../helpers";

/** Código que o app autenticador mostraria agora (ou `offset` passos depois). */
const codeFor = (secret: string, at: Date, offset = 0) => hotp(base32Decode(secret), totpStep(at) + offset);

const setup = async () => {
  const h = makeCtx();
  const app = buildApp(h.ctx);
  const req = (method: string, url: string, token?: string, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload !== undefined ? { payload: payload as any } : {}) });
  /** conta pronta (senha definitiva) com sessão aberta */
  const account = async (username: string, role: "admin" | "operador" = "operador") => {
    await req("POST", "/api/users", TOKEN, { username, displayName: username, role, password: "provisoria-1234" });
    const t = (await req("POST", "/api/auth/login", undefined, { username, password: "provisoria-1234" })).json().token;
    await req("POST", "/api/auth/password", t, { currentPassword: "provisoria-1234", newPassword: "definitiva-1234" });
    return t as string;
  };
  /** ativa a 2FA na conta e devolve o segredo e os códigos de recuperação */
  const enable = async (token: string) => {
    const s = (await req("POST", "/api/auth/mfa/setup", token)).json();
    const r = (await req("POST", "/api/auth/mfa/enable", token, { code: codeFor(s.secret, h.ctx.clock()) })).json();
    return { secret: s.secret as string, recovery: r.recoveryCodes as string[], setup: s };
  };
  return { ...h, app, req, account, enable };
};

describe("verificação em duas etapas", () => {
  it("ativar: QR code, código obrigatório e 10 códigos de recuperação", async () => {
    const t = await setup();
    const tok = await t.account("maria");
    const s = (await t.req("POST", "/api/auth/mfa/setup", tok)).json();
    expect(s.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(s.otpauthUri).toMatch(/^otpauth:\/\/totp\/WeDeals%20WAPE%3Amaria\?secret=/);
    expect(s.qrSvg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    expect(s.qrSvg).not.toMatch(/<script|on\w+=/i);

    expect((await t.req("POST", "/api/auth/mfa/enable", tok, { code: "000000" })).statusCode).toBe(400);
    const ok = (await t.req("POST", "/api/auth/mfa/enable", tok, { code: codeFor(s.secret, t.ctx.clock()) })).json();
    expect(ok.recoveryCodes).toHaveLength(10);
    const me = (await t.req("GET", "/api/auth/me", tok)).json();
    expect(me.user.mfaEnabled).toBe(true);
    expect(me.mfa.recoveryCodesLeft).toBe(10);
    // segredo nunca volta em nenhuma resposta depois de ativado
    expect(JSON.stringify((await t.req("GET", "/api/users", TOKEN)).json())).not.toContain(s.secret);
  });

  it("login em duas etapas: senha, depois código; código não pode ser reutilizado", async () => {
    const t = await setup();
    const { secret } = await t.enable(await t.account("joao"));
    t.advance(60_000);

    const step1 = (await t.req("POST", "/api/auth/login", undefined, { username: "joao", password: "definitiva-1234" })).json();
    expect(step1).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
    expect(step1.token).toBeUndefined();

    expect((await t.req("POST", "/api/auth/login/mfa", undefined, { mfaToken: step1.mfaToken, code: "123456" })).statusCode).toBe(401);
    const code = codeFor(secret, t.ctx.clock());
    const ok = await t.req("POST", "/api/auth/login/mfa", undefined, { mfaToken: step1.mfaToken, code });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toMatch(/^wds_/);
    expect((await t.req("GET", "/api/dashboard", ok.json().token)).statusCode).toBe(200);

    // o mesmo código não serve para outro login (replay)
    const again = (await t.req("POST", "/api/auth/login", undefined, { username: "joao", password: "definitiva-1234" })).json();
    expect((await t.req("POST", "/api/auth/login/mfa", undefined, { mfaToken: again.mfaToken, code })).statusCode).toBe(401);
    // o desafio também não é reaproveitável depois de usado
    expect((await t.req("POST", "/api/auth/login/mfa", undefined, { mfaToken: step1.mfaToken, code: codeFor(secret, t.ctx.clock(), 1) })).json().code).toBe("mfa_expired");
  });

  it("desafio expira em 5 minutos e trava após 5 códigos errados", async () => {
    const t = await setup();
    const { secret } = await t.enable(await t.account("ana"));
    const login = async () => (await t.req("POST", "/api/auth/login", undefined, { username: "ana", password: "definitiva-1234" })).json().mfaToken;

    const old = await login();
    t.advance(6 * 60_000);
    expect((await t.req("POST", "/api/auth/login/mfa", undefined, { mfaToken: old, code: codeFor(secret, t.ctx.clock()) })).json().code).toBe("mfa_expired");

    const m = await login();
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await t.req("POST", "/api/auth/login/mfa", undefined, { mfaToken: m, code: `00000${i}` })).statusCode);
    expect(codes.at(-1)).toBe(429);
    expect((await t.req("POST", "/api/auth/login/mfa", undefined, { mfaToken: m, code: codeFor(secret, t.ctx.clock()) })).statusCode).not.toBe(200);
  });

  it("código de recuperação entra uma vez só", async () => {
    const t = await setup();
    const { recovery } = await t.enable(await t.account("bia"));
    const login = async () => (await t.req("POST", "/api/auth/login", undefined, { username: "bia", password: "definitiva-1234" })).json().mfaToken;
    const r1 = (await t.req("POST", "/api/auth/login/mfa", undefined, { mfaToken: await login(), code: recovery[0].toUpperCase() })).json();
    expect(r1.token).toBeDefined();
    expect(r1.recoveryCodesLeft).toBe(9);
    expect((await t.req("POST", "/api/auth/login/mfa", undefined, { mfaToken: await login(), code: recovery[0] })).statusCode).toBe(401);
    const log = (await t.req("GET", "/api/activity?actor=bia", TOKEN)).json();
    expect(log.find((e: any) => e.action === "auth.login" && e.detail?.mfa === "recovery")).toBeTruthy();
  });

  it("gerar novos códigos invalida os antigos; desativar exige senha e código", async () => {
    const t = await setup();
    const tok = await t.account("caio");
    const { secret, recovery } = await t.enable(tok);
    t.advance(60_000);
    const fresh = (await t.req("POST", "/api/auth/mfa/recovery-codes", tok, { code: codeFor(secret, t.ctx.clock()) })).json().recoveryCodes;
    expect(fresh).toHaveLength(10);
    const m = (await t.req("POST", "/api/auth/login", undefined, { username: "caio", password: "definitiva-1234" })).json().mfaToken;
    expect((await t.req("POST", "/api/auth/login/mfa", undefined, { mfaToken: m, code: recovery[1] })).statusCode).toBe(401);

    expect((await t.req("POST", "/api/auth/mfa/disable", tok, { password: "errada-errada", code: fresh[0] })).statusCode).toBe(400);
    expect((await t.req("POST", "/api/auth/mfa/disable", tok, { password: "definitiva-1234", code: fresh[0] })).statusCode).toBe(200);
    expect((await t.req("POST", "/api/auth/login", undefined, { username: "caio", password: "definitiva-1234" })).json().token).toBeDefined();
  });

  it("ativar encerra as outras sessões (que entraram só com senha)", async () => {
    const t = await setup();
    const a = await t.account("duda");
    const b = (await t.req("POST", "/api/auth/login", undefined, { username: "duda", password: "definitiva-1234" })).json().token;
    await t.enable(a);
    expect((await t.req("GET", "/api/dashboard", a)).statusCode).toBe(200);
    expect((await t.req("GET", "/api/dashboard", b)).statusCode).toBe(401);
  });

  it("política: admin precisa ativar na própria conta antes de exigir; depois, quem não tem é levado a ativar", async () => {
    const t = await setup();
    const adm = await t.account("chefe", "admin");
    const op = await t.account("oper");
    expect((await t.req("PUT", "/api/settings/security", adm, { requireMfaForAll: true })).statusCode).toBe(400);
    await t.enable(adm);
    expect((await t.req("PUT", "/api/settings/security", adm, { requireMfaForAll: true })).json()).toEqual({ requireMfaForAdmins: false, requireMfaForAll: true });

    const blocked = await t.req("GET", "/api/dashboard", op);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe("mfa_setup_required");
    expect((await t.req("GET", "/api/auth/me", op)).json().mfa.required).toBe(true);
    await t.enable(op);
    expect((await t.req("GET", "/api/dashboard", op)).statusCode).toBe(200);
    // obrigatória: não dá para desativar
    expect((await t.req("POST", "/api/auth/mfa/disable", op, { password: "definitiva-1234", code: "x" })).json().error).toMatch(/obrigatória/);
    // operador não mexe na política; o token de emergência continua entrando
    expect((await t.req("PUT", "/api/settings/security", op, { requireMfaForAll: false })).statusCode).toBe(403);
    expect((await t.req("GET", "/api/dashboard", TOKEN)).statusCode).toBe(200);
  });

  it("admin reseta a 2FA de quem perdeu o celular", async () => {
    const t = await setup();
    const tok = await t.account("edu");
    await t.enable(tok);
    const id = (await t.req("GET", "/api/auth/me", tok)).json().user.id;
    expect((await t.req("POST", `/api/users/${id}/mfa/reset`, TOKEN)).statusCode).toBe(200);
    expect((await t.req("GET", "/api/dashboard", tok)).statusCode).toBe(401); // sessões encerradas
    const login = (await t.req("POST", "/api/auth/login", undefined, { username: "edu", password: "definitiva-1234" })).json();
    expect(login.token).toBeDefined();
    expect(login.user.mfaEnabled).toBe(false);
  });

  it("o token de administrador não usa 2FA", async () => {
    const t = await setup();
    expect((await t.req("POST", "/api/auth/mfa/setup", TOKEN)).statusCode).toBe(400);
  });
});
