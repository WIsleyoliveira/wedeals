import { describe, expect, it, vi } from "vitest";
import { learnWeights } from "../../src/brain/learning";
import { confirmAssistedPublication, dispatchDue, distributeOffer, evaluate, planQueue, runCycle } from "../../src/brain/pipeline";
import { seedDemo } from "../../src/db/seed";
import { AssistedWhatsAppChannel, TelegramChannel } from "../../src/distribution/channels";
import { linkAffiliateUrl } from "../../src/links/importer";
import type { MarketplaceAdapter } from "../../src/marketplaces/adapter";
import { MercadoLivreAdapter } from "../../src/marketplaces/mercadolivre";
import { SheinImportAdapter } from "../../src/marketplaces/shein";
import { ShopeeAffiliateAdapter } from "../../src/marketplaces/shopee";
import { groupInput, makeCtx } from "../helpers";

const byExt = (ctx: ReturnType<typeof makeCtx>["ctx"], id: string) =>
  ctx.repo.listOffers({ limit: 500 }).find((o) => o.externalId === id)!;

describe("pipeline do Mega Brain (integração com SQLite)", () => {
  it("classifica, rejeita, aguarda link e agenda nos grupos compatíveis", async () => {
    const { ctx } = makeCtx();
    seedDemo(ctx);
    const r = await runCycle(ctx);

    expect(byExt(ctx, "SHP-DEMO-2").status).toBe("rejected"); // desconto inflado
    expect(byExt(ctx, "SHP-DEMO-2").rejectReason).toMatch(/desconto falso/);
    expect(byExt(ctx, "MLB-DEMO-3").rejectReason).toMatch(/reputação/);
    expect(byExt(ctx, "MLB-DEMO-2").status).toBe("awaiting_link"); // ML sem link: depende de importação
    expect(byExt(ctx, "SHEIN-DEMO-2").status).toBe("awaiting_link");
    expect(byExt(ctx, "MLB-DEMO-1").status).toBe("queued");
    expect(r.queue.scheduled).toBeGreaterThan(0);

    // SHEIN só vai para grupos que aceitam SHEIN/moda; "Casa & Cozinha" nunca recebe SHEIN.
    const groups = ctx.repo.listGroups();
    const casa = groups.find((g) => g.name.includes("Casa"))!;
    const moda = groups.find((g) => g.name.includes("Moda"))!;
    const casaOffers = ctx.repo.listPublications({ groupId: casa.id }).map((p) => ctx.repo.getOffer(p.offerId)!);
    expect(casaOffers.every((o) => o.category === "casa" && o.marketplace !== "shein")).toBe(true);
    const modaOffers = ctx.repo.listPublications({ groupId: moda.id }).map((p) => ctx.repo.getOffer(p.offerId)!);
    expect(modaOffers.length).toBeGreaterThan(0);
    expect(modaOffers.every((o) => o.marketplace === "shein")).toBe(true);

    // WhatsApp → pronto para o admin; Telegram com PUBLISH_ENABLED=false → dry_run (nada enviado)
    expect(r.dispatch.ready).toBeGreaterThan(0);
    expect(r.dispatch.dryRun).toBeGreaterThan(0);
    expect(r.dispatch.delivered).toBe(0);
  });

  it("não republica a mesma oferta no mesmo grupo (anti-repetição)", async () => {
    const { ctx, advance } = makeCtx();
    seedDemo(ctx);
    await runCycle(ctx);
    const before = ctx.repo.listPublications({ limit: 1000 }).length;
    // reaprovar ofertas e replanejar 1 dia depois: carência de 7 dias deve bloquear
    advance(86_400_000);
    ctx.repo.db.prepare("UPDATE offers SET status='approved' WHERE status='queued'").run();
    await planQueue(ctx);
    expect(ctx.repo.listPublications({ limit: 1000 }).length).toBe(before);
  });

  it("vinculação de link libera a oferta para a fila", async () => {
    const { ctx } = makeCtx();
    seedDemo(ctx);
    await evaluate(ctx);
    const o = byExt(ctx, "MLB-DEMO-2");
    expect(linkAffiliateUrl(ctx.repo, o.id, "https://golpe.com/x", ctx.clock()).ok).toBe(false);
    expect(linkAffiliateUrl(ctx.repo, o.id, "https://mercadolivre.com.br/sec/abc", ctx.clock()).ok).toBe(true);
    expect(ctx.repo.getOffer(o.id)!.status).toBe("approved");
    const q = await planQueue(ctx);
    expect(q.scheduled).toBeGreaterThan(0);
  });

  it("revalidação: preço que subiu impede publicação", async () => {
    const refresh = vi.fn().mockResolvedValue({ price: 999, inStock: true });
    const ml = new MercadoLivreAdapter("");
    const mlFake: MarketplaceAdapter = Object.assign(Object.create(ml), { marketplace: "mercadolivre", refresh, status: () => ml.status(), search: async () => [], generateAffiliateLink: async () => null });
    const { ctx, advance } = makeCtx({
      adapters: { mercadolivre: mlFake, shopee: new ShopeeAffiliateAdapter({ appId: "", appSecret: "", apiUrl: "" }), shein: new SheinImportAdapter() },
    });
    seedDemo(ctx);
    await runCycle(ctx);
    advance(6 * 3_600_000); // todas as publicações agendadas vencem
    await dispatchDue(ctx);
    const o = byExt(ctx, "MLB-DEMO-1");
    expect(refresh).toHaveBeenCalled();
    expect(o.status).toBe("expired");
    const pubs = ctx.repo.listPublications({ limit: 100 }).filter((p) => p.offerId === o.id);
    expect(pubs.every((p) => p.status === "skipped")).toBe(true);
  });

  it("grupo pausado não recebe; retomado volta a receber", async () => {
    const { ctx } = makeCtx();
    seedDemo(ctx);
    for (const g of ctx.repo.listGroups()) ctx.repo.updateGroup(g.id, { status: "paused" });
    await evaluate(ctx);
    expect((await planQueue(ctx)).scheduled).toBe(0);
    const g = ctx.repo.listGroups()[0];
    ctx.repo.updateGroup(g.id, { status: "active" });
    expect((await planQueue(ctx)).scheduled).toBeGreaterThan(0);
  });

  it("distribui uma oferta para vários grupos respeitando as regras de cada um", async () => {
    const { ctx } = makeCtx();
    seedDemo(ctx);
    await evaluate(ctx);
    const o = byExt(ctx, "MLB-DEMO-1"); // eletrônicos, Mercado Livre
    const ids = ctx.repo.listGroups().map((g) => g.id);
    const r = await distributeOffer(ctx, o.id, ids);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ok = r.results.filter((x) => x.ok).length;
    const blocked = r.results.filter((x) => !x.ok).map((x) => x.reason);
    expect(ok).toBe(2); // Ofertas Gerais + Telegram
    expect(blocked).toEqual(expect.arrayContaining(["marketplace não permitido"]));
  });

  it("limite diário por grupo é respeitado", async () => {
    const { ctx } = makeCtx();
    const g = ctx.repo.createGroup(groupInput({ maxDailyPosts: 2, minIntervalMinutes: 5, windowStart: "00:00", windowEnd: "23:59" }), ctx.clock());
    for (let i = 0; i < 5; i++) {
      ctx.repo.upsertOffer({ marketplace: "shopee", externalId: `L${i}`, title: `Oferta ${i}`, url: "https://shopee.com.br/x", affiliateUrl: "https://s.shopee.com.br/x", price: 50, originalPrice: 100, category: "casa", sellerReputation: 0.9, commissionRate: 0.1 }, ctx.clock());
    }
    await evaluate(ctx);
    await planQueue(ctx);
    const pubs = ctx.repo.listPublications({ groupId: g.id });
    const byDay = new Map<string, number>();
    for (const p of pubs) byDay.set(p.scheduledFor.slice(0, 10), (byDay.get(p.scheduledFor.slice(0, 10)) ?? 0) + 1);
    expect(Math.max(...byDay.values())).toBeLessThanOrEqual(2);
  });

  it("publicação assistida: admin confirma e métricas aprendem dentro dos limites", async () => {
    const { ctx } = makeCtx();
    seedDemo(ctx);
    await runCycle(ctx);
    const ready = ctx.repo.listPublications({ statuses: ["ready_for_admin"] });
    for (const p of ready) expect(confirmAssistedPublication(ctx.repo, p.id, ctx.clock()).ok).toBe(true);
    expect(confirmAssistedPublication(ctx.repo, ready[0].id, ctx.clock()).ok).toBe(false); // não confirma duas vezes
    // cliques e comissão agregados em uma publicação "casa"
    const casaPub = ready.find((p) => ctx.repo.getOffer(p.offerId)!.category === "casa")!;
    for (let i = 0; i < 20; i++) ctx.repo.incrementClick(casaPub.trackingCode, ctx.clock());
    ctx.repo.upsertCommission({ marketplace: "shopee", externalOrderRef: "O1", trackingCode: casaPub.trackingCode, saleAmount: 100, commissionAmount: 10, status: "approved", occurredAt: ctx.clock().toISOString() });
    ctx.repo.setSetting("learning.bounds", { min: 0.3, max: 0.8, maxStep: 0.1, minPublications: 1 });
    const w = learnWeights(ctx.repo, ctx.clock());
    expect(w.category.casa).toBeCloseTo(0.6, 5); // 0.5 + passo máximo 0.1
    for (const v of Object.values(w.category)) {
      expect(v).toBeGreaterThanOrEqual(0.3);
      expect(v).toBeLessThanOrEqual(0.8);
    }
  });

  it("Telegram só envia de verdade com PUBLISH_ENABLED=true", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    const off = makeCtx({ channels: [new AssistedWhatsAppChannel(), new TelegramChannel("tok", false, fetcher)] });
    seedDemo(off.ctx);
    await runCycle(off.ctx);
    expect(fetcher).not.toHaveBeenCalled();

    const on = makeCtx({ channels: [new AssistedWhatsAppChannel(), new TelegramChannel("tok", true, fetcher)] });
    seedDemo(on.ctx);
    const r = await runCycle(on.ctx);
    expect(fetcher).toHaveBeenCalled();
    expect(String(fetcher.mock.calls[0][0])).toMatch(/^https:\/\/api\.telegram\.org\/bottok\/send(Photo|Message)$/);
    expect(r.dispatch.delivered).toBeGreaterThan(0);
  });

  it("publicações fora da janela aguardam", async () => {
    const { ctx, setNow } = makeCtx();
    ctx.repo.createGroup(groupInput({ windowStart: "08:00", windowEnd: "22:00" }), ctx.clock());
    ctx.repo.upsertOffer({ marketplace: "shopee", externalId: "W1", title: "Oferta", url: "https://shopee.com.br/x", affiliateUrl: "https://s.shopee.com.br/x", price: 50, originalPrice: 100, category: "casa", sellerReputation: 0.9 }, ctx.clock());
    setNow(new Date("2026-11-27T06:00:00Z")); // 03:00 BRT — pesquisa de madrugada continua
    await evaluate(ctx);
    await planQueue(ctx);
    const r = await dispatchDue(ctx);
    expect(r.ready).toBe(0);
    setNow(new Date("2026-11-27T11:01:00Z"));
    expect((await dispatchDue(ctx)).ready).toBe(1);
  });
});
