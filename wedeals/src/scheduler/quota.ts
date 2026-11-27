import type { Repo } from "../db/repo";

export interface QuotaRule {
  perHour: number;
  perDay: number;
}

export const DEFAULT_QUOTAS: Record<string, QuotaRule> = {
  shopee: { perHour: 120, perDay: 2000 },
  mercadolivre: { perHour: 300, perDay: 5000 },
  shein: { perHour: 0, perDay: 0 },
  ai: { perHour: 60, perDay: 500 },
  telegram: { perHour: 600, perDay: 5000 },
};

/** Controle de cotas por provedor (janela horária e diária), persistido no banco. */
export class QuotaManager {
  constructor(
    private repo: Repo,
    private rules: Record<string, QuotaRule> = DEFAULT_QUOTAS,
  ) {}

  private used(provider: string, window: string): number {
    const r = this.repo.db.prepare("SELECT used FROM quota_usage WHERE provider=? AND window=?").get(provider, window) as
      | { used: number }
      | undefined;
    return r?.used ?? 0;
  }

  tryConsume(provider: string, now: Date, n = 1): boolean {
    const rule = this.rules[provider];
    if (!rule) return true;
    const h = "h:" + now.toISOString().slice(0, 13);
    const d = "d:" + now.toISOString().slice(0, 10);
    if (this.used(provider, h) + n > rule.perHour || this.used(provider, d) + n > rule.perDay) return false;
    const up = this.repo.db.prepare(
      "INSERT INTO quota_usage (provider, window, used) VALUES (?,?,?) ON CONFLICT(provider, window) DO UPDATE SET used = used + excluded.used",
    );
    up.run(provider, h, n);
    up.run(provider, d, n);
    return true;
  }

  snapshot(now: Date) {
    const h = "h:" + now.toISOString().slice(0, 13);
    const d = "d:" + now.toISOString().slice(0, 10);
    return Object.entries(this.rules).map(([provider, rule]) => ({
      provider,
      hour: { used: this.used(provider, h), limit: rule.perHour },
      day: { used: this.used(provider, d), limit: rule.perDay },
    }));
  }
}
