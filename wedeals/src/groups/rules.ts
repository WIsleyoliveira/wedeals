import type { Group, Offer, Publication } from "../domain/types";

/** Horário de Brasília (sem horário de verão desde 2019). */
export const TZ_OFFSET_MINUTES = -180;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export function parseHHMM(s: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw new Error(`horário inválido: ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutos desde a meia-noite local e início (UTC) do dia local. */
function localParts(d: Date) {
  const local = d.getTime() + TZ_OFFSET_MINUTES * MIN;
  const dayStartLocal = Math.floor(local / DAY) * DAY;
  return { minuteOfDay: Math.floor((local - dayStartLocal) / MIN), dayStartUtc: dayStartLocal - TZ_OFFSET_MINUTES * MIN };
}

export function isWithinWindow(g: Pick<Group, "windowStart" | "windowEnd">, d: Date): boolean {
  const { minuteOfDay } = localParts(d);
  const s = parseHHMM(g.windowStart);
  const e = parseHHMM(g.windowEnd);
  return s <= e ? minuteOfDay >= s && minuteOfDay < e : minuteOfDay >= s || minuteOfDay < e;
}

export interface Compatibility {
  ok: boolean;
  reason?: string;
}

export function isCompatible(
  g: Group,
  offer: Offer,
  lastSameOffer: Publication | undefined,
  now: Date,
): Compatibility {
  if (g.status !== "active") return { ok: false, reason: "grupo pausado" };
  if (!offer.affiliateUrl) return { ok: false, reason: "oferta sem link de afiliado" };
  if (g.marketplaces.length && !g.marketplaces.includes(offer.marketplace)) return { ok: false, reason: "marketplace não permitido" };
  if (g.categories.length && !g.categories.includes(offer.category)) return { ok: false, reason: "categoria não permitida" };
  if ((offer.dealScore ?? 0) < g.minDealScore) return { ok: false, reason: "Deal Score abaixo do mínimo do grupo" };
  if (lastSameOffer) {
    const last = new Date(lastSameOffer.scheduledFor).getTime();
    if (now.getTime() - last < g.repostCooldownDays * DAY) return { ok: false, reason: "oferta repetida dentro do período de carência" };
  }
  return { ok: true };
}

/**
 * Próximo horário permitido para publicar no grupo, respeitando janela, intervalo mínimo e limite diário.
 * `activity` = publicações agendadas/feitas do grupo desde o início do dia local anterior.
 * Busca até `horizonDays` à frente; retorna null se não houver vaga.
 */
export function nextSlot(g: Group, activity: Publication[], now: Date, horizonDays = 2): Date | null {
  const start = parseHHMM(g.windowStart);
  const end = parseHHMM(g.windowEnd);
  const times = activity.map((p) => new Date(p.scheduledFor).getTime()).sort((a, b) => a - b);
  const interval = g.minIntervalMinutes * MIN;
  let t = now.getTime();
  const limit = now.getTime() + horizonDays * DAY;

  while (t <= limit) {
    const d = new Date(t);
    const { minuteOfDay, dayStartUtc } = localParts(d);
    if (!isWithinWindow(g, d)) {
      // pula para o próximo início de janela
      const todayStart = dayStartUtc + start * MIN;
      // janela normal já encerrada hoje → amanhã; antes da janela (ou janela noturna) → hoje
      t = start <= end && minuteOfDay >= start ? todayStart + DAY : todayStart;
      continue;
    }
    const dayCount = times.filter((x) => x >= dayStartUtc && x < dayStartUtc + DAY).length;
    if (dayCount >= g.maxDailyPosts) {
      t = dayStartUtc + DAY + start * MIN;
      continue;
    }
    const conflict = times.find((x) => Math.abs(x - t) < interval);
    if (conflict !== undefined) {
      t = conflict + interval;
      continue;
    }
    return d;
  }
  return null;
}
