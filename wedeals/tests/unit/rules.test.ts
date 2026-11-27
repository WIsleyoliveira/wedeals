import { describe, expect, it } from "vitest";
import type { Publication } from "../../src/domain/types";
import { isCompatible, isWithinWindow, nextSlot } from "../../src/groups/rules";
import { T0, group, offer } from "../helpers";

const at = (iso: string) => new Date(iso);
const pub = (scheduledFor: string): Publication => ({
  id: 1, offerId: 1, groupId: 1, scheduledFor, status: "scheduled", message: "", trackingCode: "abcdef", imageUrl: null, publishedAt: null, error: null,
});

describe("janela de publicação (horário de Brasília)", () => {
  it("respeita início e fim", () => {
    const g = group({ windowStart: "08:00", windowEnd: "22:00" });
    expect(isWithinWindow(g, at("2026-11-27T11:00:00Z"))).toBe(true); // 08:00 BRT
    expect(isWithinWindow(g, at("2026-11-27T10:59:00Z"))).toBe(false); // 07:59 BRT
    expect(isWithinWindow(g, at("2026-11-28T01:00:00Z"))).toBe(false); // 22:00 BRT
  });
  it("suporta janela que atravessa a meia-noite", () => {
    const g = group({ windowStart: "20:00", windowEnd: "02:00" });
    expect(isWithinWindow(g, at("2026-11-28T04:00:00Z"))).toBe(true); // 01:00 BRT
    expect(isWithinWindow(g, at("2026-11-27T15:00:00Z"))).toBe(false); // 12:00 BRT
  });
});

describe("nextSlot", () => {
  it("publica agora quando livre", () => {
    expect(nextSlot(group(), [], T0)?.toISOString()).toBe(T0.toISOString());
  });
  it("respeita intervalo mínimo", () => {
    const s = nextSlot(group({ minIntervalMinutes: 30 }), [pub(T0.toISOString())], T0)!;
    expect(s.getTime() - T0.getTime()).toBe(30 * 60_000);
  });
  it("respeita limite diário e passa para o próximo dia", () => {
    const g = group({ maxDailyPosts: 2, minIntervalMinutes: 5 });
    const s = nextSlot(g, [pub("2026-11-27T12:00:00Z"), pub("2026-11-27T13:00:00Z")], T0)!;
    expect(s.toISOString()).toBe("2026-11-28T11:00:00.000Z"); // 08:00 BRT do dia seguinte
  });
  it("antes da janela agenda para a abertura", () => {
    const s = nextSlot(group(), [], at("2026-11-27T06:00:00Z"))!; // 03:00 BRT
    expect(s.toISOString()).toBe("2026-11-27T11:00:00.000Z");
  });
  it("depois da janela agenda para o dia seguinte", () => {
    const s = nextSlot(group(), [], at("2026-11-28T02:00:00Z"))!; // 23:00 BRT
    expect(s.toISOString()).toBe("2026-11-28T11:00:00.000Z");
  });
});

describe("compatibilidade oferta × grupo", () => {
  it("bloqueia grupo pausado, sem link, marketplace/categoria e score", () => {
    expect(isCompatible(group({ status: "paused" }), offer(), undefined, T0).ok).toBe(false);
    expect(isCompatible(group(), offer({ affiliateUrl: null }), undefined, T0).ok).toBe(false);
    expect(isCompatible(group({ marketplaces: ["shein"] }), offer(), undefined, T0).ok).toBe(false);
    expect(isCompatible(group({ categories: ["moda"] }), offer(), undefined, T0).ok).toBe(false);
    expect(isCompatible(group({ minDealScore: 90 }), offer({ dealScore: 70 }), undefined, T0).ok).toBe(false);
    expect(isCompatible(group(), offer(), undefined, T0).ok).toBe(true);
  });
  it("impede repetição da mesma oferta dentro da carência", () => {
    const g = group({ repostCooldownDays: 7 });
    expect(isCompatible(g, offer(), pub("2026-11-24T15:00:00Z"), T0).reason).toMatch(/repetida/);
    expect(isCompatible(g, offer(), pub("2026-11-10T15:00:00Z"), T0).ok).toBe(true);
  });
});
