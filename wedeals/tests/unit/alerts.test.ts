import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { runBackup } from "../../src/db/backup";
import { openDatabase } from "../../src/db/database";
import { AlertManager, alertConfigFromEnv, buildNotifier, memoryStore, redact } from "../../src/ops/alerts";
import { collectIssues } from "../../src/ops/monitor";
import { createAlerting } from "../../src/ops/runtime";
import { buildApp } from "../../src/server/app";
import { T0, TOKEN, makeCtx } from "../helpers";

type Call = { url: string; body: any; headers: any };
const recorder = (status = 200) => {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    const raw = init?.body;
    calls.push({ url, headers: init?.headers, body: typeof raw === "string" ? JSON.parse(raw) : raw });
    return new Response("{}", { status });
  };
  return { calls, fetcher };
};
const MIN = 60_000;
const at = (min: number) => new Date(T0.getTime() + min * MIN);
const cfg = { repeatHours: 6, instance: "teste" };

describe("alertas", () => {
  it("config: Telegram usa o token do bot do Telegram por padrão; webhook só https", () => {
    const c = alertConfigFromEnv({ TELEGRAM_BOT_TOKEN: "123:abc", ALERT_TELEGRAM_CHAT_ID: "-100", DOMAIN: "x.com.br" });
    expect(c).toMatchObject({ telegramBotToken: "123:abc", telegramChatId: "-100", repeatHours: 6, instance: "x.com.br" });
    expect(alertConfigFromEnv({ ALERT_TELEGRAM_BOT_TOKEN: "9:z", TELEGRAM_BOT_TOKEN: "1:a" }).telegramBotToken).toBe("9:z");
    expect(() => alertConfigFromEnv({ ALERT_WEBHOOK_URL: "http://hooks.exemplo.test/x" })).toThrow(/https/);
  });

  it("redige segredos e padrões de token", () => {
    const t = redact("falha token=abc123 em https://api.telegram.org/bot123456:AAAAAAAAAAAAAAAAAAAAAAAA/x Bearer meu-token-secreto-1234 SEGREDO-X", ["SEGREDO-X"]);
    expect(t).not.toMatch(/abc123|AAAAAAAA|meu-token|SEGREDO-X/);
  });

  it("envia para Telegram e webhook, sem vazar segredos", async () => {
    const r = recorder();
    const n = buildNotifier({ telegramBotToken: "111111:BBBBBBBBBBBBBBBBBBBBBBBB", telegramChatId: "-42", webhookUrl: "https://hooks.exemplo.test/w", repeatHours: 6, instance: "i" }, ["ADMIN-SECRETO"], r.fetcher);
    expect(n.channels).toEqual(["telegram", "webhook"]);
    await n.send("erro com ADMIN-SECRETO");
    expect(r.calls.map((c) => c.url)).toEqual(["https://api.telegram.org/bot111111:BBBBBBBBBBBBBBBBBBBBBBBB/sendMessage", "https://hooks.exemplo.test/w"]);
    expect(r.calls[0].body).toMatchObject({ chat_id: "-42", text: "erro com ***" });
    expect(r.calls[1].body).toEqual({ text: "erro com ***", content: "erro com ***" });
  });

  it("alerta uma vez, repete depois do intervalo e avisa quando resolve", async () => {
    const r = recorder();
    const n = buildNotifier({ telegramBotToken: "1:a", telegramChatId: "1", webhookUrl: "", repeatHours: 6, instance: "i" }, [], r.fetcher);
    const m = new AlertManager(n, memoryStore(), cfg, () => {});
    const issue = [{ key: "worker:parado", message: "Worker parado" }];
    expect((await m.update(issue, at(0))).sent).toEqual(["worker:parado"]);
    expect((await m.update(issue, at(5))).sent).toEqual([]); // sem repetição a cada 5 min
    expect((await m.update(issue, at(6 * 60))).sent).toEqual(["worker:parado"]);
    expect(r.calls[1].body.text).toMatch(/Continua Worker parado \(desde/);
    const res = await m.update([], at(6 * 60 + 5));
    expect(res.resolved).toEqual(["worker:parado"]);
    expect(r.calls.at(-1)!.body.text).toContain("✅ Resolvido: Worker parado");
    expect(r.calls).toHaveLength(3);
  });

  it("se o envio falha, tenta de novo na próxima verificação", async () => {
    const r = recorder(500);
    const n = buildNotifier({ telegramBotToken: "1:a", telegramChatId: "1", webhookUrl: "", repeatHours: 6, instance: "i" }, [], r.fetcher);
    const m = new AlertManager(n, memoryStore(), cfg, () => {});
    const issue = [{ key: "k", message: "m" }];
    expect((await m.update(issue, at(0))).sendError).toMatch(/Telegram HTTP 500/);
    await m.update(issue, at(5));
    expect(r.calls).toHaveLength(2);
  });

  it("sem canal, só registra no log e não repete a cada verificação", async () => {
    const lines: string[] = [];
    const m = new AlertManager(buildNotifier(alertConfigFromEnv({}), []), memoryStore(), cfg, (l) => lines.push(l));
    expect(m.enabled).toBe(false);
    await m.update([{ key: "k", message: "m" }], at(0));
    await m.update([{ key: "k", message: "m" }], at(5));
    expect(lines).toHaveLength(1);
  });
});

describe("monitor", () => {
  const record = (ctx: any, agent: string, status: "ok" | "error", min: number, result = "") => ctx.repo.recordAgentRun(agent, status, result, at(min));
  const all = ["distribuicao", "classificacao", "fila", "pesquisa", "aprendizado"];

  it("tudo em dia: nenhum problema", () => {
    const { ctx } = makeCtx();
    for (const a of all) record(ctx, a, "ok", 0);
    expect(collectIssues(ctx, at(5), at(0))).toEqual([]);
  });

  it("dá tempo ao worker na subida e depois acusa worker parado", () => {
    const { ctx } = makeCtx();
    expect(collectIssues(ctx, at(5), at(0))).toEqual([]);
    const issues = collectIssues(ctx, at(14 * 60), at(0));
    expect(issues.map((i) => i.key)).toEqual(["worker:parado"]);
  });

  it("acusa agente atrasado e agente com erro, separados", () => {
    const { ctx } = makeCtx();
    for (const a of all) record(ctx, a, "ok", 0);
    record(ctx, "pesquisa", "error", 0, "shopee: HTTP 401");
    record(ctx, "distribuicao", "ok", 0);
    for (const a of ["classificacao", "fila", "pesquisa", "aprendizado"]) record(ctx, a, a === "pesquisa" ? "error" : "ok", 20, "shopee: HTTP 401");
    const keys = collectIssues(ctx, at(21), at(0)).map((i) => i.key).sort();
    expect(keys).toEqual(["agente:distribuicao:atrasado", "agente:pesquisa:erro"]);
  });
});

describe("API de alertas", () => {
  it("teste de alerta: 409 sem canal, envia com canal; exige token", async () => {
    const { ctx } = makeCtx();
    const off = buildApp(ctx, createAlerting(ctx, {}).ops);
    expect((await off.inject({ method: "POST", url: "/api/alerts/test", headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(409);
    expect((await off.inject({ method: "POST", url: "/api/alerts/test" })).statusCode).toBe(401);

    const r = recorder();
    const on = buildApp(ctx, createAlerting(ctx, { TELEGRAM_BOT_TOKEN: "1:a", ALERT_TELEGRAM_CHAT_ID: "-1" }, r.fetcher).ops);
    const res = await on.inject({ method: "POST", url: "/api/alerts/test", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.json()).toEqual({ ok: true, channels: ["telegram"] });
    expect(r.calls[0].body.text).toContain("Alerta de teste");
    const list = await on.inject({ url: "/api/alerts", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(list.json()).toMatchObject({ channels: ["telegram"], monitoring: true, active: [], lastCheckAt: null });
    expect(list.json().history[0]).toMatchObject({ type: "teste", source: "token-admin" });
  });

  it("verificar agora: registra o problema, mostra no painel e o resolvido no histórico", async () => {
    const { ctx, setNow } = makeCtx();
    const alerting = createAlerting(ctx, {});
    const app = buildApp(ctx, alerting.ops);
    const hdr = { authorization: `Bearer ${TOKEN}` };
    const all = ["distribuicao", "classificacao", "fila", "pesquisa", "aprendizado"];
    for (const a of all) ctx.repo.recordAgentRun(a, "ok", "", at(0));
    ctx.repo.recordAgentRun("pesquisa", "error", "shopee: HTTP 401", at(0));

    const r1 = (await app.inject({ method: "POST", url: "/api/alerts/check", headers: hdr })).json();
    expect(r1.active).toHaveLength(1);
    expect(r1.active[0]).toMatchObject({ key: "agente:pesquisa:erro", message: expect.stringContaining("HTTP 401") });
    expect(r1.history[0]).toMatchObject({ type: "novo", source: "monitor", delivered: false });
    expect(r1.lastCheckAt).toBe(at(0).toISOString());

    // verificar de novo sem mudança não duplica o histórico
    const r2 = (await app.inject({ method: "POST", url: "/api/alerts/check", headers: hdr })).json();
    expect(r2.history).toHaveLength(1);

    for (const a of all) ctx.repo.recordAgentRun(a, "ok", "", at(3));
    setNow(at(3));
    const r3 = (await app.inject({ method: "POST", url: "/api/alerts/check", headers: hdr })).json();
    expect(r3.active).toEqual([]);
    expect(r3.history.map((h: any) => h.type)).toEqual(["resolvido", "novo"]);
  });

  it("sem monitor no processo, verificar agora responde 409", async () => {
    const { ctx } = makeCtx();
    const r = await buildApp(ctx).inject({ method: "POST", url: "/api/alerts/check", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(r.statusCode).toBe(409);
  });
});

describe("backup externo", () => {
  const setup = () => {
    const dir = mkdtempSync(join(tmpdir(), "wedeals-up-"));
    const dbPath = join(dir, "wedeals.db");
    openDatabase(dbPath).close();
    return { dir, env: { DATABASE_PATH: dbPath, BACKUP_DIR: join(dir, "bk"), BACKUP_S3_ENDPOINT: "https://s3.exemplo.test", BACKUP_S3_BUCKET: "bkp", BACKUP_S3_ACCESS_KEY_ID: "AK", BACKUP_S3_SECRET_ACCESS_KEY: "SK", BACKUP_S3_PREFIX: "prod" } };
  };

  it("envia a cópia comprimida para o bucket", async () => {
    const { env } = setup();
    const r = recorder();
    const alerts = new AlertManager(buildNotifier(alertConfigFromEnv({}), []), memoryStore(), cfg, () => {});
    const out = await runBackup({ env, alerts, fetcher: r.fetcher, now: () => T0, log: () => {} });
    expect(out).toMatchObject({ ok: true, key: "prod/wedeals-20261127T150000Z.db.gz" });
    expect(r.calls[0].url).toBe("https://s3.exemplo.test/bkp/prod/wedeals-20261127T150000Z.db.gz");
    const db = gunzipSync(Buffer.from(r.calls[0].body as Uint8Array));
    expect(db.subarray(0, 15).toString()).toBe("SQLite format 3");
  });

  it("falha no envio vira alerta, mas a cópia local fica", async () => {
    const { env } = setup();
    const up = recorder(403);
    const tg = recorder();
    const n = buildNotifier({ telegramBotToken: "1:a", telegramChatId: "1", webhookUrl: "", repeatHours: 6, instance: "i" }, ["SK"], tg.fetcher);
    const alerts = new AlertManager(n, memoryStore(), cfg, () => {});
    const recorded: any[] = [];
    const out = await runBackup({ env, alerts, fetcher: up.fetcher, now: () => T0, log: () => {}, record: (r) => recorded.push(r) });
    expect(out.ok).toBe(false);
    expect(readdirSync(env.BACKUP_DIR)).toHaveLength(1);
    expect(tg.calls[0].body.text).toMatch(/Envio do backup .* HTTP 403/);
    expect(recorded[0].events).toEqual([expect.objectContaining({ type: "novo", key: "backup:externo" })]);
  });
});
