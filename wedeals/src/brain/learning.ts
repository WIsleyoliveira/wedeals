import type { Repo } from "../db/repo";
import { priceBand } from "./score";

export interface LearningBounds {
  min: number; // menor peso permitido (0..1)
  max: number; // maior peso permitido
  maxStep: number; // variação máxima por ciclo de aprendizado
  minPublications: number; // amostra mínima para ajustar
}

export const DEFAULT_BOUNDS: LearningBounds = { min: 0.2, max: 0.9, maxStep: 0.1, minPublications: 5 };

export interface PerformanceWeights {
  category: Record<string, number>;
  priceBand: Record<string, number>;
  updatedAt: string | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Aprende com métricas AGREGADAS (cliques e comissões por publicação). Nunca usa dados pessoais.
 * Sem amostra mínima o peso fica neutro (0.5). Ajustes respeitam limites e passo máximo do admin.
 */
export function learnWeights(repo: Repo, now: Date): PerformanceWeights {
  const bounds = repo.getSetting<LearningBounds>("learning.bounds", DEFAULT_BOUNDS);
  const prev = repo.getSetting<PerformanceWeights>("learning.weights", { category: {}, priceBand: {}, updatedAt: null });

  const rows = repo.db
    .prepare(
      `SELECT o.category, o.price, p.tracking_code,
        COALESCE((SELECT SUM(count) FROM clicks c WHERE c.tracking_code = p.tracking_code), 0) clicks,
        COALESCE((SELECT SUM(commission_amount) FROM commissions m WHERE m.tracking_code = p.tracking_code
                  AND m.status != 'cancelled'), 0) commission
       FROM publications p JOIN offers o ON o.id = p.offer_id WHERE p.status = 'published'`,
    )
    .all() as { category: string; price: number; clicks: number; commission: number }[];

  const agg = (keyOf: (r: (typeof rows)[number]) => string) => {
    const m = new Map<string, { n: number; clicks: number; commission: number }>();
    for (const r of rows) {
      const k = keyOf(r);
      const a = m.get(k) ?? { n: 0, clicks: 0, commission: 0 };
      a.n++;
      a.clicks += r.clicks;
      a.commission += r.commission;
      m.set(k, a);
    }
    return m;
  };

  const toWeights = (m: Map<string, { n: number; clicks: number; commission: number }>, prevW: Record<string, number>) => {
    const eligible = [...m.entries()].filter(([, a]) => a.n >= bounds.minPublications);
    // valor por publicação = comissão (peso 0.7) + cliques (peso 0.3), normalizados pelo maior.
    const maxComm = Math.max(0.0001, ...eligible.map(([, a]) => a.commission / a.n));
    const maxClicks = Math.max(0.0001, ...eligible.map(([, a]) => a.clicks / a.n));
    const out: Record<string, number> = { ...prevW };
    for (const [k, a] of eligible) {
      const target = 0.7 * (a.commission / a.n / maxComm) + 0.3 * (a.clicks / a.n / maxClicks);
      const before = prevW[k] ?? 0.5;
      const stepped = before + clamp(target - before, -bounds.maxStep, bounds.maxStep);
      out[k] = Math.round(clamp(stepped, bounds.min, bounds.max) * 1000) / 1000;
    }
    return out;
  };

  const weights: PerformanceWeights = {
    category: toWeights(agg((r) => r.category), prev.category),
    priceBand: toWeights(agg((r) => priceBand(r.price)), prev.priceBand),
    updatedAt: now.toISOString(),
  };
  repo.setSetting("learning.weights", weights);
  return weights;
}

export function currentWeights(repo: Repo): PerformanceWeights {
  return repo.getSetting<PerformanceWeights>("learning.weights", { category: {}, priceBand: {}, updatedAt: null });
}
