import type { BrainContext } from "../brain/pipeline";
import type { AppConfig } from "../config";
import type { Fetcher } from "../marketplaces/adapter";
import type { AppOps } from "../server/app";
import { AlertManager, alertConfigFromEnv, buildNotifier, type AlertState, type AlertStore, type Notifier } from "./alerts";

const STATE_KEY = "alerts.state";

/** Segredos que nunca podem aparecer num alerta. */
export const secretsOf = (cfg: AppConfig, env: NodeJS.ProcessEnv) =>
  [cfg.adminToken, cfg.shopee.appSecret, cfg.mlAccessToken, cfg.telegramBotToken, env.BACKUP_S3_SECRET_ACCESS_KEY ?? "", env.BACKUP_S3_ACCESS_KEY_ID ?? ""].filter(Boolean);

export function createAlerting(ctx: BrainContext, env: NodeJS.ProcessEnv = process.env, fetcher: Fetcher = fetch) {
  const acfg = alertConfigFromEnv(env);
  const notifier: Notifier = buildNotifier(acfg, secretsOf(ctx.cfg, env), fetcher);
  const store: AlertStore = {
    load: () => ctx.repo.getSetting<AlertState>(STATE_KEY, {}),
    save: (s) => ctx.repo.setSetting(STATE_KEY, s),
  };
  const manager = new AlertManager(notifier, store, acfg);
  const ops: AppOps = {
    alerts: {
      channels: notifier.channels,
      active: () => Object.entries(store.load()).map(([key, v]) => ({ key, since: v.since, message: v.message })),
      test: () => notifier.send(`WeDeals · ${acfg.instance}\n\n🔔 Alerta de teste: os avisos de falha chegam aqui.`),
    },
  };
  return { notifier, manager, ops, instance: acfg.instance };
}
