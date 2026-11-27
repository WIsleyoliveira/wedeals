import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_TOKEN_LENGTH = 24;

/** Comparação em tempo constante (via hash, para não vazar o tamanho do token). */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function bearer(header: string | undefined): string | undefined {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return m?.[1].trim();
}

/** Rate limit simples em memória (janela fixa) por chave. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) this.prune(now);
      return true;
    }
    h.count++;
    return h.count <= this.max;
  }
  private prune(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
