import { describe, expect, it } from "vitest";
import { median, priceBand, scoreOffer } from "../../src/brain/score";
import type { RawOffer } from "../../src/domain/types";

const base: RawOffer = {
  marketplace: "mercadolivre",
  externalId: "1",
  title: "x",
  url: "https://www.mercadolivre.com.br/x",
  price: 100,
  originalPrice: 150,
  category: "casa",
  sellerReputation: 0.9,
  commissionRate: 0.05,
};

describe("Deal Score", () => {
  it("mede desconto real contra a mediana histórica", () => {
    const r = scoreOffer({ offer: base, history: [150, 140, 150, 160] });
    expect(r.rejected).toBe(false);
    expect(r.realDiscountPct).toBeCloseTo(1 - 100 / 150, 3);
    expect(r.breakdown.realDiscount).toBeGreaterThan(20);
  });

  it("rejeita desconto falso (preço 'de' inflado sem queda real)", () => {
    const r = scoreOffer({ offer: { ...base, price: 100, originalPrice: 400 }, history: [100, 99, 101, 100] });
    expect(r.rejected).toBe(true);
    expect(r.reason).toMatch(/desconto falso/);
  });

  it("rejeita preço acima da mediana histórica", () => {
    const r = scoreOffer({ offer: { ...base, price: 130 }, history: [100, 100, 100] });
    expect(r.rejected).toBe(true);
  });

  it("rejeita vendedor com reputação baixa, exceto loja oficial", () => {
    expect(scoreOffer({ offer: { ...base, sellerReputation: 0.3 }, history: [] }).rejected).toBe(true);
    expect(scoreOffer({ offer: { ...base, sellerReputation: 0.3, officialStore: true }, history: [] }).rejected).toBe(false);
  });

  it("rejeita produto sem estoque e preço inválido", () => {
    expect(scoreOffer({ offer: { ...base, inStock: false }, history: [] }).reason).toBe("sem estoque");
    expect(scoreOffer({ offer: { ...base, price: 0 }, history: [] }).rejected).toBe(true);
  });

  it("comissão alta não compensa oferta ruim (teto de 10 pontos)", () => {
    const ruim = scoreOffer({ offer: { ...base, originalPrice: null, commissionRate: 0.9 }, history: [100, 100, 100] });
    const boa = scoreOffer({ offer: { ...base, commissionRate: 0 }, history: [160, 150, 155] });
    expect(ruim.breakdown.commission).toBe(10);
    expect(boa.score).toBeGreaterThan(ruim.score);
    expect(ruim.score).toBeLessThan(50);
  });

  it("sem histórico, desconto anunciado conta pela metade", () => {
    const r = scoreOffer({ offer: base, history: [] });
    expect(r.realDiscountPct).toBeNull();
    expect(r.breakdown.realDiscount).toBeCloseTo(((50 / 150) * 0.5 / 0.5) * 35, 0);
  });

  it("score fica entre 0 e 100", () => {
    const max = scoreOffer({
      offer: { ...base, price: 10, originalPrice: 100, officialStore: true, couponDiscount: 5, commissionRate: 0.5 },
      history: [100, 100, 100],
      categoryPerformance: 1,
      priceBandPerformance: 1,
    });
    expect(max.score).toBeLessThanOrEqual(100);
    expect(max.score).toBeGreaterThan(90);
  });

  it("utilitários", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(priceBand(49.9)).toBe("ate50");
    expect(priceBand(500)).toBe("500mais");
  });
});
