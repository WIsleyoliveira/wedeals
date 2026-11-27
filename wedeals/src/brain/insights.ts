import type { Repo } from "../db/repo";
import { priceBand } from "./score";

/**
 * Inteligência comercial a partir de dados agregados reais do banco. Quando não há dados suficientes,
 * retorna listas vazias e `sampleSize` — nunca estimativas inventadas.
 */
export function commercialInsights(repo: Repo) {
  const db = repo.db;
  const pubs = db
    .prepare(
      `SELECT p.tracking_code, p.published_at, p.hook_source, o.category, o.price, o.marketplace, o.title, o.id offer_id,
        COALESCE((SELECT SUM(count) FROM clicks c WHERE c.tracking_code = p.tracking_code),0) clicks,
        COALESCE((SELECT COUNT(*) FROM commissions m WHERE m.tracking_code = p.tracking_code AND m.status!='cancelled'),0) sales,
        COALESCE((SELECT SUM(commission_amount) FROM commissions m WHERE m.tracking_code = p.tracking_code AND m.status!='cancelled'),0) commission
       FROM publications p JOIN offers o ON o.id = p.offer_id WHERE p.status = 'published'`,
    )
    .all() as any[];

  const group = (key: (r: any) => string) => {
    const m = new Map<string, { key: string; publications: number; clicks: number; sales: number; commission: number }>();
    for (const r of pubs) {
      const k = key(r);
      const a = m.get(k) ?? { key: k, publications: 0, clicks: 0, sales: 0, commission: 0 };
      a.publications++;
      a.clicks += r.clicks;
      a.sales += r.sales;
      a.commission += r.commission;
      m.set(k, a);
    }
    return [...m.values()].map((a) => ({
      ...a,
      commission: Math.round(a.commission * 100) / 100,
      conversionRate: a.clicks ? Math.round((a.sales / a.clicks) * 10000) / 100 : null,
      clicksPerPost: Math.round((a.clicks / a.publications) * 10) / 10,
    }));
  };

  const byCategory = group((r) => r.category).sort((a, b) => (b.conversionRate ?? -1) - (a.conversionRate ?? -1));
  const byMarketplace = group((r) => r.marketplace).sort((a, b) => b.commission - a.commission);
  // chamada escrita pela IA local x modelo pronto (só publicações com origem registrada)
  const byHookSource = group((r) => r.hook_source ?? "sem registro").filter((a) => a.key !== "sem registro");
  const byPriceBand = group((r) => priceBand(r.price)).sort((a, b) => (b.conversionRate ?? -1) - (a.conversionRate ?? -1));

  const byHour = (
    db
      .prepare(
        "SELECT CAST(substr(hour, 12, 2) AS INTEGER) h, SUM(count) clicks FROM clicks GROUP BY h ORDER BY clicks DESC",
      )
      .all() as any[]
  ).map((r) => ({ hourUtc: r.h, clicks: r.clicks }));

  const topProducts = group((r) => `${r.offer_id}|${r.title}`)
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10)
    .map((a) => ({ ...a, key: a.key.split("|").slice(1).join("|") }));

  const lowPerformers = group((r) => `${r.offer_id}|${r.title}`)
    .filter((a) => a.publications >= 3 && a.clicks === 0)
    .map((a) => ({ ...a, key: a.key.split("|").slice(1).join("|") }));

  const coupons = db
    .prepare(
      `SELECT id, marketplace, title, coupon_code, coupon_discount, deal_score FROM offers
       WHERE coupon_code IS NOT NULL AND status IN ('approved','queued','awaiting_link') ORDER BY deal_score DESC LIMIT 10`,
    )
    .all();

  const strongDiscounts = db
    .prepare(
      `SELECT id, marketplace, title, price, deal_score FROM offers
       WHERE status IN ('approved','queued','awaiting_link') AND deal_score >= 75 ORDER BY deal_score DESC LIMIT 10`,
    )
    .all();

  // Frequência: compara cliques por post nos grupos com mais e menos posts por dia.
  const freq = db
    .prepare(
      `SELECT g.id, g.name, COUNT(p.id) posts,
        COUNT(DISTINCT substr(p.published_at,1,10)) days,
        COALESCE(SUM((SELECT SUM(count) FROM clicks c WHERE c.tracking_code = p.tracking_code)),0) clicks
       FROM groups g LEFT JOIN publications p ON p.group_id = g.id AND p.status='published' GROUP BY g.id`,
    )
    .all() as any[];
  const frequency = freq
    .filter((f) => f.posts > 0)
    .map((f) => ({
      group: f.name,
      postsPerDay: Math.round((f.posts / Math.max(1, f.days)) * 10) / 10,
      clicksPerPost: Math.round((f.clicks / f.posts) * 10) / 10,
    }));

  // Sazonalidade: categorias cujo volume do mês corrente supera a média mensal histórica.
  const month = new Date().toISOString().slice(0, 7);
  const seasonal = (
    db
      .prepare(
        `SELECT category, SUM(CASE WHEN substr(occurred_at,1,7)=? THEN 1 ELSE 0 END) this_month,
          COUNT(*) * 1.0 / MAX(1, COUNT(DISTINCT substr(occurred_at,1,7))) avg_month
         FROM commissions WHERE category IS NOT NULL AND status!='cancelled' GROUP BY category`,
      )
      .all(month) as any[]
  )
    .filter((r) => r.this_month > r.avg_month * 1.3 && r.this_month >= 3)
    .map((r) => ({ category: r.category, thisMonth: r.this_month, monthlyAverage: Math.round(r.avg_month * 10) / 10 }));

  return {
    sampleSize: pubs.length,
    byCategory,
    byMarketplace,
    byPriceBand,
    byHookSource,
    byHour,
    topProducts,
    lowPerformers,
    coupons,
    strongDiscounts,
    frequency,
    seasonal,
  };
}
