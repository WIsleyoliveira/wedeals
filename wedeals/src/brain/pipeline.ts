import { randomBytes } from "node:crypto";
import type { TextProvider } from "../ai/provider";
import type { AppConfig } from "../config";
import type { Repo } from "../db/repo";
import { MARKETPLACES, type Group, type Marketplace, type Offer } from "../domain/types";
import type { ChannelRouter } from "../distribution/channels";
import { isCompatible, isWithinWindow, nextSlot } from "../groups/rules";
import { isAuthorizedImage } from "../links/validation";
import type { AdapterRegistry } from "../marketplaces/registry";
import { generateHook, renderMessage } from "../messages/generator";
import type { QuotaManager } from "../scheduler/quota";
import { currentWeights, learnWeights } from "./learning";
import { priceBand, scoreOffer } from "./score";

export interface BrainContext {
  repo: Repo;
  cfg: AppConfig;
  adapters: AdapterRegistry;
  router: ChannelRouter;
  ai: TextProvider;
  quotas: QuotaManager;
  clock: () => Date;
}

export interface BrainSettings {
  minScore: number; // score global mínimo para aprovar
  minSellerReputation: number;
  maxPriceIncreaseOnRevalidation: number; // 0.05 = 5%
  keywords: Record<Marketplace, string[]>;
  searchLimit: number;
}

export const DEFAULT_BRAIN_SETTINGS: BrainSettings = {
  minScore: 50,
  minSellerReputation: 0.7,
  maxPriceIncreaseOnRevalidation: 0.05,
  keywords: { mercadolivre: ["fone bluetooth", "air fryer"], shopee: ["organizador", "fone bluetooth"], shein: [] },
  searchLimit: 20,
};

export const brainSettings = (repo: Repo) => ({
  ...DEFAULT_BRAIN_SETTINGS,
  ...repo.getSetting<Partial<BrainSettings>>("brain.settings", {}),
});

const DAY = 86_400_000;

/** Etapa 1: pesquisar produtos e ofertas pelos adapters oficiais (respeitando cotas). */
export async function research(ctx: BrainContext) {
  const s = brainSettings(ctx.repo);
  let found = 0;
  const errors: string[] = [];
  const limited: string[] = []; // cota esgotada é comportamento esperado, não falha
  for (const m of MARKETPLACES) {
    const adapter = ctx.adapters[m];
    if (!adapter.status().searchEnabled) continue;
    for (const kw of s.keywords[m] ?? []) {
      if (!ctx.quotas.tryConsume(m, ctx.clock())) {
        limited.push(`${m}: cota esgotada`);
        break;
      }
      try {
        const offers = await adapter.search(kw, s.searchLimit);
        for (const o of offers) ctx.repo.upsertOffer(o, ctx.clock());
        found += offers.length;
      } catch (e) {
        errors.push(`${m}: ${(e as Error).message}`);
      }
    }
  }
  ctx.repo.incrCounter("researched", ctx.clock(), found);
  const notes = [...errors, ...limited].join(" | ");
  ctx.repo.recordAgentRun("pesquisa", errors.length ? "error" : "ok", `${found} ofertas${notes ? `; ${notes}` : ""}`, ctx.clock());
  return { found, errors, limited };
}

/** Etapas 2–8: cupons, validação, histórico, classificação, vendedor, conversão, link de afiliado. */
export async function evaluate(ctx: BrainContext, limit = 200) {
  const s = brainSettings(ctx.repo);
  const w = currentWeights(ctx.repo);
  const now = ctx.clock();
  const res = { approved: 0, rejected: 0, awaitingLink: 0 };
  for (const offer of ctx.repo.listOffers({ status: "discovered", limit })) {
    const history = ctx.repo.priceHistory(offer.marketplace, offer.externalId, new Date(now.getTime() - 30 * DAY));
    history.pop(); // remove a leitura atual: compara com o passado
    const r = scoreOffer({
      offer,
      history,
      categoryPerformance: w.category[offer.category],
      priceBandPerformance: w.priceBand[priceBand(offer.price)],
      minSellerReputation: s.minSellerReputation,
    });
    if (r.rejected || r.score < s.minScore) {
      ctx.repo.updateOfferEvaluation(
        offer.id,
        { status: "rejected", dealScore: r.score, rejectReason: r.reason ?? `Deal Score ${r.score} < ${s.minScore}`, breakdown: r.breakdown },
        now,
      );
      ctx.repo.incrCounter("rejected", now);
      res.rejected++;
      continue;
    }
    let affiliate = offer.affiliateUrl;
    if (!affiliate) {
      try {
        affiliate = await ctx.adapters[offer.marketplace].generateAffiliateLink(offer.url, `wedeals-${offer.id}`);
        if (affiliate) ctx.repo.setAffiliateUrl(offer.id, affiliate, now);
      } catch {
        affiliate = null;
      }
    }
    const status = affiliate ? "approved" : "awaiting_link";
    ctx.repo.updateOfferEvaluation(offer.id, { status, dealScore: r.score, rejectReason: null, breakdown: r.breakdown }, now);
    ctx.repo.incrCounter("approved", now);
    if (affiliate) res.approved++;
    else res.awaitingLink++;
  }
  ctx.repo.recordAgentRun("classificacao", "ok", JSON.stringify(res), now);
  return res;
}

const newTrackingCode = () => randomBytes(6).toString("base64url");

/** Agenda uma oferta em um grupo se todas as regras do grupo permitirem. */
export async function scheduleOfferForGroup(
  ctx: BrainContext,
  offer: Offer,
  g: Group,
): Promise<{ ok: boolean; reason?: string; publicationId?: number; scheduledFor?: string }> {
  const now = ctx.clock();
  const compat = isCompatible(g, offer, ctx.repo.lastOfferPublicationInGroup(offer.id, g.id), now);
  if (!compat.ok) return compat;
  const activity = ctx.repo.groupActivitySince(g.id, new Date(now.getTime() - DAY));
  const slot = nextSlot(g, activity, now);
  if (!slot) return { ok: false, reason: "sem horário disponível (limite diário/intervalo)" };
  const code = newTrackingCode();
  const link = `${ctx.cfg.publicBaseUrl}/r/${code}`;
  const hook = ctx.quotas.tryConsume("ai", now) ? await generateHook(ctx.ai, offer) : null;
  const pub = ctx.repo.createPublication(
    {
      offerId: offer.id,
      groupId: g.id,
      scheduledFor: slot.toISOString(),
      status: "scheduled",
      message: renderMessage({ offer, link, template: g.template, hook }),
      trackingCode: code,
      imageUrl: isAuthorizedImage(offer.imageUrl) ? offer.imageUrl! : null,
    },
    now,
  );
  return { ok: true, publicationId: pub.id, scheduledFor: pub.scheduledFor };
}

/** Etapas 9–12: mensagem, imagem autorizada, grupos compatíveis e fila. */
export async function planQueue(ctx: BrainContext, maxOffers = 50) {
  const now = ctx.clock();
  const groups = ctx.repo.listGroups().filter((g) => g.status === "active");
  let scheduled = 0;
  const offers = ctx.repo.listOffers({ status: "approved", limit: maxOffers });
  for (const offer of offers) {
    let any = false;
    for (const g of groups) {
      const r = await scheduleOfferForGroup(ctx, offer, g);
      if (r.ok) {
        scheduled++;
        any = true;
      }
    }
    if (any) ctx.repo.updateOfferEvaluation(offer.id, { status: "queued" }, now);
  }
  ctx.repo.recordAgentRun("fila", "ok", `${scheduled} publicações agendadas`, now);
  return { scheduled };
}

/** Distribui manualmente uma oferta para vários grupos autorizados (sempre sujeito às regras de cada grupo). */
export async function distributeOffer(ctx: BrainContext, offerId: number, groupIds: number[]) {
  const offer = ctx.repo.getOffer(offerId);
  if (!offer) return { ok: false as const, error: "oferta não encontrada" };
  if (!["approved", "queued", "published"].includes(offer.status)) {
    return { ok: false as const, error: `oferta com status ${offer.status} não pode ser distribuída` };
  }
  const results = [];
  for (const id of [...new Set(groupIds)].slice(0, 200)) {
    const g = ctx.repo.getGroup(id);
    results.push({ groupId: id, ...(g ? await scheduleOfferForGroup(ctx, offer, g) : { ok: false, reason: "grupo não encontrado" }) });
  }
  if (results.some((r) => r.ok) && offer.status === "approved") ctx.repo.updateOfferEvaluation(offer.id, { status: "queued" }, ctx.clock());
  ctx.repo.audit("offer.distribute", { offerId, groupIds }, ctx.clock());
  return { ok: true as const, results };
}

/** Etapa 13: revalida preço/estoque antes de publicar. */
export async function revalidate(ctx: BrainContext, offer: Offer): Promise<{ ok: boolean; reason?: string }> {
  const s = brainSettings(ctx.repo);
  if (!ctx.quotas.tryConsume(offer.marketplace, ctx.clock())) return { ok: true }; // sem cota: mantém dados atuais
  try {
    const fresh = await ctx.adapters[offer.marketplace].refresh(offer.externalId, offer.url);
    if (!fresh) return { ok: true };
    ctx.repo.addPricePoint(offer.marketplace, offer.externalId, fresh.price, ctx.clock());
    if (fresh.inStock === false) return { ok: false, reason: "sem estoque na revalidação" };
    if (fresh.price > offer.price * (1 + s.maxPriceIncreaseOnRevalidation)) {
      return { ok: false, reason: `preço subiu de ${offer.price} para ${fresh.price}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `falha na revalidação: ${(e as Error).message}` };
  }
}

/** Etapas 13–15: para publicações vencidas, revalida, entrega pelo canal e registra o resultado. */
export async function dispatchDue(ctx: BrainContext) {
  const now = ctx.clock();
  const due = ctx.repo
    .listPublications({ statuses: ["scheduled"], limit: 500 })
    .filter((p) => new Date(p.scheduledFor) <= now);
  const res = { delivered: 0, ready: 0, skipped: 0, failed: 0, dryRun: 0 };
  for (const pub of due) {
    const group = ctx.repo.getGroup(pub.groupId);
    const offer = ctx.repo.getOffer(pub.offerId);
    if (!group || !offer) continue;
    if (group.status !== "active") {
      ctx.repo.updatePublication(pub.id, "skipped", { error: "grupo pausado" });
      res.skipped++;
      continue;
    }
    if (!isWithinWindow(group, now)) continue; // aguarda a janela
    const check = await revalidate(ctx, offer);
    if (!check.ok) {
      ctx.repo.updatePublication(pub.id, "skipped", { error: check.reason });
      ctx.repo.updateOfferEvaluation(offer.id, { status: "expired", rejectReason: check.reason }, now);
      res.skipped++;
      continue;
    }
    const channel = ctx.router.pick(group);
    const r = await channel.deliver(pub, group, offer);
    ctx.repo.updatePublication(pub.id, r.status, {
      publishedAt: r.status === "published" ? now.toISOString() : undefined,
      error: r.error,
    });
    ctx.repo.audit("publication.deliver", { id: pub.id, channel: channel.id, status: r.status }, now);
    if (r.status === "published") {
      ctx.repo.updateOfferEvaluation(offer.id, { status: "published" }, now);
      ctx.repo.incrCounter("published", now);
      res.delivered++;
    } else if (r.status === "ready_for_admin") res.ready++;
    else if (r.status === "dry_run") res.dryRun++;
    else res.failed++;
  }
  ctx.repo.recordAgentRun("distribuicao", res.failed ? "error" : "ok", JSON.stringify(res), now);
  return res;
}

/** Publicação assistida: o admin confirma que enviou a mensagem no WhatsApp. */
export function confirmAssistedPublication(repo: Repo, pubId: number, now: Date): { ok: boolean; error?: string } {
  const pub = repo.getPublication(pubId);
  if (!pub) return { ok: false, error: "publicação não encontrada" };
  if (pub.status !== "ready_for_admin" && pub.status !== "scheduled") return { ok: false, error: `status atual: ${pub.status}` };
  repo.updatePublication(pubId, "published", { publishedAt: now.toISOString() });
  repo.updateOfferEvaluation(pub.offerId, { status: "published" }, now);
  repo.incrCounter("published", now);
  repo.audit("publication.confirmed_by_admin", { id: pubId }, now);
  return { ok: true };
}

/** Etapas 16–17: métricas e aprendizado. */
export function learn(ctx: BrainContext) {
  const w = learnWeights(ctx.repo, ctx.clock());
  ctx.repo.recordAgentRun("aprendizado", "ok", `${Object.keys(w.category).length} categorias ajustadas`, ctx.clock());
  return w;
}

/** Ciclo completo do Mega Brain. */
export async function runCycle(ctx: BrainContext) {
  const r1 = await research(ctx);
  const r2 = await evaluate(ctx);
  const r3 = await planQueue(ctx);
  const r4 = await dispatchDue(ctx);
  const r5 = learn(ctx);
  return { research: r1, evaluate: r2, queue: r3, dispatch: r4, learnedCategories: Object.keys(r5.category).length };
}
