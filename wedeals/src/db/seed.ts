import { pathToFileURL } from "node:url";
import type { BrainContext } from "../brain/pipeline";
import { loadConfig } from "../config";
import { buildContext } from "../context";
import type { RawOffer } from "../domain/types";

/**
 * Dados de DEMONSTRAÇÃO, todos marcados com is_demo=1 (o dashboard exibe o aviso).
 * Produtos, preços e links são fictícios e não devem ser publicados.
 */
export const DEMO_OFFERS: (RawOffer & { history: number[] })[] = [
  { marketplace: "mercadolivre", externalId: "MLB-DEMO-1", title: "[DEMO] Fone Bluetooth com cancelamento de ruído", url: "https://www.mercadolivre.com.br/demo-fone/p/MLBDEMO1", affiliateUrl: "https://mercadolivre.com.br/sec/demo1", imageUrl: "https://http2.mlstatic.com/demo-fone.webp", price: 149.9, originalPrice: 299.9, category: "eletronicos", sellerReputation: 0.95, officialStore: true, commissionRate: 0.08, history: [259.9, 249.9, 259.9, 239.9] },
  { marketplace: "mercadolivre", externalId: "MLB-DEMO-2", title: "[DEMO] Air fryer 4L antiaderente", url: "https://www.mercadolivre.com.br/demo-airfryer/p/MLBDEMO2", affiliateUrl: null, imageUrl: "https://http2.mlstatic.com/demo-airfryer.webp", price: 279.0, originalPrice: 449.0, category: "casa", sellerReputation: 0.9, commissionRate: 0.06, history: [399, 389, 409, 399] },
  { marketplace: "shopee", externalId: "SHP-DEMO-1", title: "[DEMO] Kit organizador de gavetas 6 peças", url: "https://shopee.com.br/demo-organizador-i.1.1", affiliateUrl: "https://s.shopee.com.br/demo1", imageUrl: "https://down-br.img.susercontent.com/demo-org.jpg", price: 39.9, originalPrice: 79.9, category: "casa", sellerReputation: 0.92, commissionRate: 0.1, couponCode: "DEMO10", couponDiscount: 5, history: [69.9, 72.9, 69.9] },
  { marketplace: "shopee", externalId: "SHP-DEMO-2", title: "[DEMO] Smartwatch com 'desconto' inflado", url: "https://shopee.com.br/demo-watch-i.1.2", affiliateUrl: "https://s.shopee.com.br/demo2", imageUrl: null, price: 199.9, originalPrice: 899.9, category: "eletronicos", sellerReputation: 0.88, commissionRate: 0.2, history: [199.9, 189.9, 199.9, 205.0] },
  { marketplace: "shein", externalId: "SHEIN-DEMO-1", title: "[DEMO] Vestido midi estampado", url: "https://br.shein.com/demo-vestido-p-1.html", affiliateUrl: "https://onelink.shein.com/demo1", imageUrl: "https://img.ltwebstatic.com/demo-vestido.jpg", price: 89.9, originalPrice: 139.9, category: "moda", officialStore: true, commissionRate: 0.12, history: [129.9, 134.9, 129.9] },
  { marketplace: "shein", externalId: "SHEIN-DEMO-2", title: "[DEMO] Tênis casual feminino", url: "https://br.shein.com/demo-tenis-p-2.html", affiliateUrl: null, imageUrl: null, price: 119.9, originalPrice: 159.9, category: "moda", officialStore: true, commissionRate: 0.1, history: [149.9, 155.9, 149.9] },
  { marketplace: "mercadolivre", externalId: "MLB-DEMO-3", title: "[DEMO] Vendedor com reputação baixa", url: "https://www.mercadolivre.com.br/demo-x/p/MLBDEMO3", affiliateUrl: "https://mercadolivre.com.br/sec/demo3", price: 59.9, originalPrice: 119.9, category: "eletronicos", sellerReputation: 0.4, commissionRate: 0.05, history: [99, 99, 99] },
];

export function seedDemo(ctx: BrainContext) {
  const { repo } = ctx;
  const now = ctx.clock();
  const DAY = 86_400_000;
  for (const o of DEMO_OFFERS) {
    const { history, ...raw } = o;
    history.forEach((p, i) => repo.addPricePoint(raw.marketplace, raw.externalId, p, new Date(now.getTime() - (history.length - i) * 5 * DAY)));
    repo.upsertOffer(raw, now, true);
  }
  repo.incrCounter("researched", now, DEMO_OFFERS.length);
  const base = {
    externalId: null, admins: ["Equipe WAPE"], audience: null, audienceSource: null, template: null, affiliateAccount: "wape-principal",
    mode: "assisted" as const, status: "active" as const, repostCooldownDays: 7, minIntervalMinutes: 20, maxDailyPosts: 15,
  };
  repo.createGroup({ ...base, name: "[DEMO] Ofertas Gerais WAPE", platform: "whatsapp", inviteLink: "https://chat.whatsapp.com/DEMO-GERAL", categories: [], marketplaces: [], windowStart: "00:00", windowEnd: "23:59", minDealScore: 55, audience: 980, audienceSource: "informed" }, now, true);
  repo.createGroup({ ...base, name: "[DEMO] Casa & Cozinha", platform: "whatsapp", inviteLink: "https://chat.whatsapp.com/DEMO-CASA", categories: ["casa"], marketplaces: ["mercadolivre", "shopee"], windowStart: "00:00", windowEnd: "23:59", minDealScore: 50, audience: 640, audienceSource: "informed" }, now, true);
  repo.createGroup({ ...base, name: "[DEMO] Moda SHEIN", platform: "whatsapp", inviteLink: "https://chat.whatsapp.com/DEMO-MODA", categories: ["moda"], marketplaces: ["shein"], windowStart: "00:00", windowEnd: "23:59", minDealScore: 50, audience: 410, audienceSource: "informed" }, now, true);
  repo.createGroup({ ...base, name: "[DEMO] Canal Telegram", platform: "telegram", inviteLink: "https://t.me/demo_wedeals", externalId: "@demo_wedeals", mode: "automatic", categories: [], marketplaces: [], windowStart: "00:00", windowEnd: "23:59", minDealScore: 60 }, now, true);
  repo.addCost({ category: "infraestrutura", description: "[DEMO] Servidor mensal", amount: 49.9, occurredAt: now.toISOString(), isDemo: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ctx = buildContext(loadConfig());
  if (ctx.repo.listGroups().length) {
    console.log("Banco já possui grupos; seed ignorado.");
  } else {
    seedDemo(ctx);
    console.log("Dados de demonstração criados (marcados como DEMO). Rode o ciclo do Mega Brain pelo dashboard.");
  }
}
