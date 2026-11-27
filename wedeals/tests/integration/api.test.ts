import { describe, expect, it } from "vitest";
import { seedDemo } from "../../src/db/seed";
import { buildApp } from "../../src/server/app";
import { TOKEN, makeCtx } from "../helpers";

const auth = { authorization: `Bearer ${TOKEN}` };

function setup() {
  const h = makeCtx();
  return { ...h, app: buildApp(h.ctx) };
}

describe("API (integração)", () => {
  it("CRUD de grupos, pausar e retomar", async () => {
    const { app } = setup();
    const create = await app.inject({
      method: "POST", url: "/api/groups", headers: auth,
      payload: { name: "Achados", platform: "whatsapp", inviteLink: "https://chat.whatsapp.com/ABC", marketplaces: ["shopee", "shein"], audience: 500, audienceSource: "informed", minDealScore: 65 },
    });
    expect(create.statusCode).toBe(201);
    const g = create.json();
    expect(g).toMatchObject({ name: "Achados", mode: "assisted", status: "active", maxDailyPosts: 20 });
    const patch = await app.inject({ method: "PATCH", url: `/api/groups/${g.id}`, headers: auth, payload: { maxDailyPosts: 8 } });
    expect(patch.json()).toMatchObject({ maxDailyPosts: 8, minDealScore: 65 }); // não sobrescreve campos não enviados
    expect((await app.inject({ method: "POST", url: `/api/groups/${g.id}/pause`, headers: auth })).json().status).toBe("paused");
    expect((await app.inject({ method: "POST", url: `/api/groups/${g.id}/resume`, headers: auth })).json().status).toBe("active");
    const bad = await app.inject({ method: "POST", url: "/api/groups", headers: auth, payload: { name: "x", platform: "sms", windowStart: "25:00" } });
    expect(bad.statusCode).toBe(400);
  });

  it("importa ofertas CSV, valida domínios e vincula links pendentes", async () => {
    const { app } = setup();
    const csv = [
      "marketplace,external_id,title,url,affiliate_url,price,original_price,category,official_store",
      "shein,S1,Vestido teste,https://br.shein.com/v-p-1.html,https://onelink.shein.com/a,89.90,139.90,moda,sim",
      "shein,S2,Blusa teste,https://br.shein.com/b-p-2.html,,59.90,149.90,moda,sim",
      "shein,S3,Golpe,https://shein-promo.golpe.com/x,,10,20,moda,1",
      "aliexpress,A1,Fora do escopo,https://aliexpress.com/x,,10,20,geral,0",
    ].join("\n");
    const r = (await app.inject({ method: "POST", url: "/api/offers/import", headers: auth, payload: { format: "csv", data: csv } })).json();
    expect(r.imported).toBe(2);
    expect(r.errors.map((e: any) => e.row)).toEqual([3, 4]);

    await app.inject({ method: "POST", url: "/api/brain/run", headers: auth });
    const pending = (await app.inject({ url: "/api/offers?status=awaiting_link", headers: auth })).json();
    expect(pending.map((o: any) => o.externalId)).toEqual(["S2"]);
    const bad = await app.inject({ method: "POST", url: `/api/offers/${pending[0].id}/link`, headers: auth, payload: { url: "https://shopee.com.br/x" } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: `/api/offers/${pending[0].id}/link`, headers: auth, payload: { url: "https://onelink.shein.com/b" } });
    expect(ok.json().ok).toBe(true);
  });

  it("dashboard, integrações, insights e configurações", async () => {
    const { app, ctx } = setup();
    seedDemo(ctx);
    await app.inject({ method: "POST", url: "/api/brain/run", headers: auth });
    const d = (await app.inject({ url: "/api/dashboard", headers: auth })).json();
    expect(d.containsDemoData).toBe(true);
    expect(d.offers.rejected).toBe(2);
    expect(d.groups.active).toBe(4);
    expect(d.perMarketplace.map((m: any) => m.marketplace)).toEqual(["mercadolivre", "shopee", "shein"]);
    const i = (await app.inject({ url: "/api/integrations", headers: auth })).json();
    expect(i.publishEnabled).toBe(false);
    expect(i.marketplaces.find((m: any) => m.marketplace === "shein").mode).toBe("import");
    expect(i.channels.find((c: any) => c.id === "whatsapp_unofficial").enabled).toBe(false);
    expect((await app.inject({ url: "/api/insights", headers: auth })).statusCode).toBe(200);
    const s = await app.inject({ method: "PUT", url: "/api/settings/brain", headers: auth, payload: { minScore: 70 } });
    expect(s.json().minScore).toBe(70);
    const lb = await app.inject({ method: "PUT", url: "/api/settings/learning-bounds", headers: auth, payload: { min: 0.9, max: 0.1, maxStep: 0.1, minPublications: 5 } });
    expect(lb.statusCode).toBe(400);
  });

  it("comissões e custos alimentam o resultado operacional", async () => {
    const { app } = setup();
    const csv = "marketplace,order_ref,sale_amount,commission_amount,status,occurred_at\nshopee,O1,100,10,paid,2026-11-20\nshein,O2,200,16,pending,2026-11-21\nmercadolivre,O3,50,3,approved,2026-11-22\nshopee,O4,abc,1,paid,2026-11-22";
    const r = (await app.inject({ method: "POST", url: "/api/commissions/import", headers: auth, payload: { format: "csv", data: csv } })).json();
    expect(r.imported).toBe(3);
    expect(r.errors).toHaveLength(1);
    await app.inject({ method: "POST", url: "/api/costs", headers: auth, payload: { category: "infraestrutura", description: "VPS", amount: 4 } });
    const d = (await app.inject({ url: "/api/dashboard", headers: auth })).json();
    expect(d.commissions).toMatchObject({ paid: 10, pending: 16, approved: 3 });
    expect(d.costs).toBe(4);
    expect(d.operatingResult).toBe(6);
    expect(d.projectedResult).toBe(9);
  });
});
