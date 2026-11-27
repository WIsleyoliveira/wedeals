import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../../src/security/auth";
import { buildApp } from "../../src/server/app";
import { TOKEN, makeCtx } from "../helpers";

const admin = { authorization: `Bearer ${TOKEN}` };
const setup = () => {
  const h = makeCtx();
  const app = buildApp(h.ctx);
  const req = (method: string, url: string, token?: string, payload?: unknown) =>
    app.inject({ method: method as any, url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload !== undefined ? { payload: payload as any } : {}) });
  const createUser = async (username: string, role: "admin" | "operador", password = "senha-provisoria-1") =>
    (await req("POST", "/api/users", TOKEN, { username, displayName: username.toUpperCase(), role, password })).json();
  const login = async (username: string, password: string) => req("POST", "/api/auth/login", undefined, { username, password });
  /** cria, entra e troca a senha provisória: devolve um token de sessão pronto para uso */
  const ready = async (username: string, role: "admin" | "operador") => {
    await createUser(username, role);
    const t = (await login(username, "senha-provisoria-1")).json().token;
    expect((await req("POST", "/api/auth/password", t, { currentPassword: "senha-provisoria-1", newPassword: "senha-definitiva-1" })).statusCode).toBe(200);
    return t as string;
  };
  return { ...h, app, req, createUser, login, ready };
};

describe("senhas", () => {
  it("hash scrypt com sal: não guarda a senha e verifica corretamente", async () => {
    const a = await hashPassword("minha senha longa");
    const b = await hashPassword("minha senha longa");
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("minha");
    expect(await verifyPassword("minha senha longa", a)).toBe(true);
    expect(await verifyPassword("minha senha longA", a)).toBe(false);
    expect(await verifyPassword("x", "md5$abc")).toBe(false);
  });
});

describe("contas por pessoa", () => {
  it("login, senha provisória obrigatória e sessão", async () => {
    const t = setup();
    const u = await t.createUser("maria", "operador");
    expect(u).toMatchObject({ username: "maria", role: "operador", mustChangePassword: true, active: true });
    expect(u.passwordHash).toBeUndefined();

    const res = await t.login("Maria", "senha-provisoria-1"); // nome sem diferenciar maiúsculas
    expect(res.statusCode).toBe(200);
    const { token, user } = res.json();
    expect(token).toMatch(/^wds_/);
    expect(user.passwordHash).toBeUndefined();

    // antes de trocar a senha, só /api/auth/*
    expect((await t.req("GET", "/api/dashboard", token)).json().code).toBe("must_change_password");
    expect((await t.req("GET", "/api/auth/me", token)).json().user.username).toBe("maria");
    expect((await t.req("POST", "/api/auth/password", token, { currentPassword: "errada-errada", newPassword: "nova-senha-123" })).statusCode).toBe(400);
    expect((await t.req("POST", "/api/auth/password", token, { currentPassword: "senha-provisoria-1", newPassword: "curta" })).statusCode).toBe(400);
    expect((await t.req("POST", "/api/auth/password", token, { currentPassword: "senha-provisoria-1", newPassword: "nova-senha-123" })).statusCode).toBe(200);
    expect((await t.req("GET", "/api/dashboard", token)).statusCode).toBe(200);

    // sair encerra a sessão
    expect((await t.req("POST", "/api/auth/logout", token)).statusCode).toBe(200);
    expect((await t.req("GET", "/api/dashboard", token)).statusCode).toBe(401);
    expect((await t.login("maria", "nova-senha-123")).statusCode).toBe(200);
  });

  it("senha errada e usuário inexistente dão a mesma resposta", async () => {
    const t = setup();
    await t.createUser("joao", "operador");
    const a = await t.login("joao", "errada-errada");
    const b = await t.login("ninguem", "errada-errada");
    expect([a.statusCode, b.statusCode]).toEqual([401, 401]);
    expect(a.json()).toEqual(b.json());
  });

  it("sessão expira em 12h", async () => {
    const t = setup();
    const token = await t.ready("ana", "operador");
    t.advance(11 * 3_600_000);
    expect((await t.req("GET", "/api/dashboard", token)).statusCode).toBe(200);
    t.advance(2 * 3_600_000);
    expect((await t.req("GET", "/api/dashboard", token)).statusCode).toBe(401);
  });

  it("operador faz o dia a dia, mas não mexe em usuários, configurações nem grupos", async () => {
    const t = setup();
    const op = await t.ready("oper", "operador");
    for (const [m, u] of [["GET", "/api/dashboard"], ["GET", "/api/assisted"], ["GET", "/api/groups"], ["POST", "/api/brain/run"]] as const)
      expect((await t.req(m, u, op, m === "POST" ? {} : undefined)).statusCode, `${m} ${u}`).toBe(200);
    for (const [m, u] of [["GET", "/api/users"], ["POST", "/api/users"], ["GET", "/api/activity"], ["PUT", "/api/settings/brain"], ["POST", "/api/groups"], ["POST", "/api/costs"], ["POST", "/api/commissions/import"], ["PATCH", "/api/users/1"]] as const)
      expect((await t.req(m, u, op, m === "GET" ? undefined : {})).statusCode, `${m} ${u}`).toBe(403);
  });

  it("administrador gerencia contas; desativar ou trocar papel derruba as sessões na hora", async () => {
    const t = setup();
    const adm = await t.ready("chefe", "admin");
    const op = await t.ready("oper", "operador");
    const opId = (await t.req("GET", "/api/users", adm)).json().find((u: any) => u.username === "oper").id;

    expect((await t.req("POST", "/api/users", adm, { username: "oper", displayName: "Outro", role: "operador", password: "senha-provisoria-1" })).statusCode).toBe(409);
    expect((await t.req("POST", "/api/users", adm, { username: "Com Espaço", displayName: "X", role: "operador", password: "senha-provisoria-1" })).statusCode).toBe(400);

    expect((await t.req("PATCH", `/api/users/${opId}`, adm, { active: false })).json().active).toBe(false);
    expect((await t.req("GET", "/api/dashboard", op)).statusCode).toBe(401);
    expect((await t.login("oper", "senha-definitiva-1")).statusCode).toBe(401);

    // redefinir senha: provisória de novo e sessões encerradas
    await t.req("PATCH", `/api/users/${opId}`, adm, { active: true });
    expect((await t.req("POST", `/api/users/${opId}/password`, adm, { password: "redefinida-123" })).statusCode).toBe(200);
    const again = (await t.login("oper", "redefinida-123")).json();
    expect(again.user.mustChangePassword).toBe(true);
  });

  it("não permite ficar sem administrador nem se desativar", async () => {
    const t = setup();
    const adm = await t.ready("unico", "admin");
    const id = (await t.req("GET", "/api/auth/me", adm)).json().user.id;
    expect((await t.req("PATCH", `/api/users/${id}`, adm, { active: false })).statusCode).toBe(400);
    expect((await t.req("PATCH", `/api/users/${id}`, TOKEN, { role: "operador" })).json().error).toMatch(/pelo menos um administrador/);
    await t.ready("segundo", "admin");
    expect((await t.req("PATCH", `/api/users/${id}`, TOKEN, { role: "operador" })).statusCode).toBe(200);
  });

  it("registra quem fez cada alteração, sem guardar senhas", async () => {
    const t = setup();
    const op = await t.ready("carla", "operador");
    await t.req("POST", "/api/brain/run", op, {});
    const log = (await t.req("GET", "/api/activity", TOKEN)).json();
    expect(log.find((e: any) => e.actor === "carla" && e.detail?.route === "POST /api/brain/run")).toBeTruthy();
    expect(log.find((e: any) => e.actor === "carla" && e.action === "auth.login")).toBeTruthy();
    expect(log.find((e: any) => e.actor === "token-admin" && e.detail?.route === "POST /api/users")).toBeTruthy();
    expect(JSON.stringify(log)).not.toMatch(/senha-provisoria|senha-definitiva/);
    const onlyCarla = (await t.req("GET", "/api/activity?actor=carla", TOKEN)).json();
    expect(onlyCarla.every((e: any) => e.actor === "carla")).toBe(true);
  });

  it("bloqueia força bruta por conta, mesmo vindo de IPs diferentes", async () => {
    const h = makeCtx({ cfg: { trustProxyHops: 1 } });
    const app = buildApp(h.ctx);
    await app.inject({ method: "POST", url: "/api/users", headers: admin, payload: { username: "alvo", displayName: "Alvo", role: "operador", password: "senha-provisoria-1" } });
    const codes = [];
    for (let i = 0; i < 7; i++)
      codes.push((await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": `198.51.100.${i}` }, payload: { username: "alvo", password: `errada-${i}-xxxx` } })).statusCode);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429]);
    // nem a senha certa entra durante o bloqueio
    const right = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-forwarded-for": "203.0.113.50" }, payload: { username: "alvo", password: "senha-provisoria-1" } });
    expect(right.statusCode).toBe(429);
  });

  it("o token de administrador continua funcionando (emergência e scripts)", async () => {
    const t = setup();
    const me = (await t.req("GET", "/api/auth/me", TOKEN)).json();
    expect(me).toMatchObject({ kind: "token", user: { username: "token-admin", role: "admin" } });
    expect((await t.req("POST", "/api/auth/password", TOKEN, { currentPassword: "x", newPassword: "yyyyyyyyyyyy" })).statusCode).toBe(400);
  });
});
