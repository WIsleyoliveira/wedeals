import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { seedDemo } from "../../src/db/seed";
import { buildApp } from "../../src/server/app";
import { TOKEN, makeCtx } from "../helpers";

/**
 * Ponta a ponta sobre um servidor HTTP real (porta efêmera): dashboard estático, login, ciclo do
 * Mega Brain, central assistida, clique rastreado, importação de comissão e reflexo nos indicadores.
 * Nenhuma publicação real é feita (PUBLISH_ENABLED=false).
 */
let app: FastifyInstance;
let base = "";
const h = makeCtx();

const call = async (path: string, init: RequestInit & { json?: unknown } = {}) => {
  const res = await fetch(base + path, {
    ...init,
    redirect: "manual",
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  return res;
};

beforeAll(async () => {
  app = buildApp(h.ctx);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
  seedDemo(h.ctx);
});
afterAll(() => app.close());

describe("E2E — central de afiliados", () => {
  it("serve o dashboard e seus assets", async () => {
    const html = await (await fetch(base + "/")).text();
    expect(html).toContain("<title>WeDeals · WAPE</title>");
    expect(html).toContain('src="/app.js"');
    expect((await fetch(base + "/app.js")).headers.get("content-type")).toMatch(/javascript/);
    expect((await fetch(base + "/styles.css")).headers.get("content-type")).toMatch(/css/);
    expect((await fetch(base + "/api/dashboard")).status).toBe(401);
  });

  it("fluxo completo: pesquisa → fila → assistido → clique → comissão → dashboard", async () => {
    const cycle = await (await call("/api/brain/run", { method: "POST", json: {} })).json();
    expect(cycle.queue.scheduled).toBeGreaterThan(0);

    const assisted = await (await call("/api/assisted")).json();
    expect(assisted.length).toBeGreaterThan(0);
    const item = assisted[0];
    expect(item.message).toContain(`/r/${item.trackingCode}`);
    expect(item.groupInviteLink).toMatch(/^https:\/\/chat\.whatsapp\.com\//);

    expect((await call(`/api/publications/${item.id}/confirm`, { method: "POST", json: {} })).status).toBe(200);

    // participante clica no link rastreado (rota pública)
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${base}/r/${item.trackingCode}`, { redirect: "manual" });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toMatch(/^https:\/\//);
    }

    // relatório do marketplace com a venda atribuída ao código de rastreio
    const csv = `marketplace,order_ref,tracking_code,sale_amount,commission_amount,status,occurred_at\n${item.marketplace},E2E-1,${item.trackingCode},150,12.5,paid,2026-11-27`;
    const imp = await (await call("/api/commissions/import", { method: "POST", json: { format: "csv", data: csv } })).json();
    expect(imp.imported).toBe(1);

    const d = await (await call("/api/dashboard")).json();
    expect(d.clicks).toBe(3);
    expect(d.offers.published).toBe(1);
    expect(d.commissions.paid).toBe(12.5);
    expect(d.operatingResult).toBeCloseTo(12.5 - 49.9, 2);
    const g = d.perGroup.find((x: any) => x.name === item.groupName);
    expect(g).toMatchObject({ published: 1, clicks: 3, attributed_sales: 1, attributed_commission: 12.5 });

    const ins = await (await call("/api/insights")).json();
    expect(ins.sampleSize).toBe(1);
    expect(ins.byMarketplace[0]).toMatchObject({ key: item.marketplace, sales: 1, conversionRate: 33.33 });

    const agents = await (await call("/api/agents")).json();
    expect(agents.map((a: any) => a.agent)).toEqual(expect.arrayContaining(["pesquisa", "classificacao", "fila", "distribuicao", "aprendizado"]));
  });

  it("nenhuma publicação real acontece sem autorização", async () => {
    const pubs = await (await call("/api/publications")).json();
    const telegram = pubs.filter((p: any) => h.ctx.repo.getGroup(p.groupId)!.platform === "telegram");
    expect(telegram.length).toBeGreaterThan(0);
    expect(telegram.every((p: any) => p.status === "dry_run" || p.status === "scheduled")).toBe(true);
    const health = await (await fetch(base + "/api/health")).json();
    expect(health.publishEnabled).toBe(false);
  });
});
