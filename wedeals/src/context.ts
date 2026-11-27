import { buildTextProvider, type TextProvider } from "./ai/provider";
import type { BrainContext } from "./brain/pipeline";
import type { AppConfig } from "./config";
import { openDatabase } from "./db/database";
import { Repo } from "./db/repo";
import { AssistedWhatsAppChannel, ChannelRouter, TelegramChannel, type DistributionChannel } from "./distribution/channels";
import type { Fetcher } from "./marketplaces/adapter";
import { buildAdapters, type AdapterRegistry } from "./marketplaces/registry";
import { DEFAULT_QUOTAS, QuotaManager } from "./scheduler/quota";

export interface ContextOverrides {
  fetcher?: Fetcher;
  adapters?: AdapterRegistry;
  channels?: DistributionChannel[];
  ai?: TextProvider;
  clock?: () => Date;
}

export function buildContext(cfg: AppConfig, o: ContextOverrides = {}): BrainContext {
  const repo = new Repo(openDatabase(cfg.databasePath));
  const fetcher = o.fetcher ?? fetch;
  return {
    repo,
    cfg,
    adapters: o.adapters ?? buildAdapters(cfg, fetcher),
    router: new ChannelRouter(
      o.channels ?? [new AssistedWhatsAppChannel(), new TelegramChannel(cfg.telegramBotToken, cfg.publishEnabled, fetcher)],
    ),
    ai: o.ai ?? buildTextProvider(cfg, fetcher),
    // cota da IA vem da configuração (AI_DAILY_BUDGET_CALLS); as demais, dos padrões
    quotas: new QuotaManager(repo, { ...DEFAULT_QUOTAS, ai: { perDay: cfg.ai.dailyBudgetCalls, perHour: Math.min(60, cfg.ai.dailyBudgetCalls) } }),
    clock: o.clock ?? (() => new Date()),
  };
}
