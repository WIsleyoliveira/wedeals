import type { RawOffer } from "../domain/types";

export const PRICE_BANDS = [
  { key: "ate50", min: 0, max: 50 },
  { key: "50a100", min: 50, max: 100 },
  { key: "100a200", min: 100, max: 200 },
  { key: "200a500", min: 200, max: 500 },
  { key: "500mais", min: 500, max: Infinity },
] as const;

export function priceBand(price: number): string {
  return (PRICE_BANDS.find((b) => price >= b.min && price < b.max) ?? PRICE_BANDS[PRICE_BANDS.length - 1]).key;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface ScoreInput {
  offer: RawOffer;
  /** Preços observados ANTES da leitura atual (últimos 30 dias). */
  history: number[];
  /** Desempenho aprendido 0..1 (0.5 = neutro). */
  categoryPerformance?: number;
  priceBandPerformance?: number;
  minSellerReputation?: number;
}

export interface ScoreBreakdown {
  realDiscount: number;
  announcedDiscount: number;
  seller: number;
  coupon: number;
  conversion: number;
  commission: number;
}

export interface ScoreResult {
  score: number;
  rejected: boolean;
  reason?: string;
  breakdown: ScoreBreakdown;
  realDiscountPct: number | null;
  inflatedOriginalPrice: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
const MIN_HISTORY = 3;

/**
 * Deal Score 0..100. A comissão tem teto de 10 pontos para que comissão alta nunca compense
 * uma oferta ruim; o desconto é medido contra a mediana histórica, não contra o "de" anunciado.
 */
export function scoreOffer(input: ScoreInput): ScoreResult {
  const { offer, history } = input;
  const minRep = input.minSellerReputation ?? 0.7;
  const empty: ScoreBreakdown = { realDiscount: 0, announcedDiscount: 0, seller: 0, coupon: 0, conversion: 0, commission: 0 };
  const reject = (reason: string, extra: Partial<ScoreResult> = {}): ScoreResult => ({
    score: 0,
    rejected: true,
    reason,
    breakdown: empty,
    realDiscountPct: null,
    inflatedOriginalPrice: false,
    ...extra,
  });

  if (!(offer.price > 0)) return reject("preço inválido");
  if (offer.inStock === false) return reject("sem estoque");
  if (offer.sellerReputation != null && offer.sellerReputation < minRep && !offer.officialStore) {
    return reject("reputação do vendedor abaixo do mínimo");
  }

  const hasHistory = history.length >= MIN_HISTORY;
  const med = hasHistory ? median(history)! : null;
  const maxHist = hasHistory ? Math.max(...history) : null;
  const realDiscountPct = med ? (med - offer.price) / med : null;
  const inflated = Boolean(offer.originalPrice && maxHist && offer.originalPrice > maxHist * 1.25);

  if (realDiscountPct != null && realDiscountPct < -0.05) {
    return reject("preço acima da mediana histórica", { realDiscountPct, inflatedOriginalPrice: inflated });
  }
  if (inflated && (realDiscountPct ?? 0) < 0.05) {
    return reject("desconto falso: preço 'de' inflado e sem queda real", {
      realDiscountPct,
      inflatedOriginalPrice: true,
    });
  }

  const announcedPct =
    offer.originalPrice && offer.originalPrice > offer.price ? (offer.originalPrice - offer.price) / offer.originalPrice : 0;

  // Sem histórico suficiente, o desconto anunciado vale metade como estimativa de desconto real.
  const effectiveReal = realDiscountPct ?? announcedPct * 0.5;

  const b: ScoreBreakdown = {
    realDiscount: clamp((effectiveReal / 0.5) * 35, 0, 35),
    announcedDiscount: inflated ? 0 : clamp((announcedPct / 0.5) * 10, 0, 10),
    seller: offer.officialStore ? 15 : offer.sellerReputation == null ? 7.5 : clamp(offer.sellerReputation * 15, 0, 15),
    coupon: offer.couponDiscount
      ? clamp((offer.couponDiscount / offer.price / 0.2) * 10, 0, 10)
      : offer.couponCode
        ? 5
        : 0,
    conversion: clamp(20 * (0.6 * (input.categoryPerformance ?? 0.5) + 0.4 * (input.priceBandPerformance ?? 0.5)), 0, 20),
    commission: clamp(((offer.commissionRate ?? 0) / 0.15) * 10, 0, 10),
  };
  const breakdown = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, round1(v)])) as unknown as ScoreBreakdown;
  const score = round1(Object.values(b).reduce((a, v) => a + v, 0));
  return { score, rejected: false, breakdown, realDiscountPct, inflatedOriginalPrice: inflated };
}
