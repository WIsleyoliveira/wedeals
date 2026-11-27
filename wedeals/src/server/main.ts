import { loadConfig } from "../config";
import { buildContext } from "../context";
import { startMonitor } from "../ops/monitor";
import { createAlerting } from "../ops/runtime";
import { buildApp } from "./app";

const cfg = loadConfig();
const ctx = buildContext(cfg);
const alerting = createAlerting(ctx);
const app = buildApp(ctx, alerting.ops);
await app.listen({ port: cfg.port, host: cfg.host });
console.log(`WeDeals em http://${cfg.host}:${cfg.port} — publicação real ${cfg.publishEnabled ? "LIBERADA" : "desligada (PUBLISH_ENABLED=false)"}`);
console.log(`Alertas: ${alerting.notifier.channels.length ? alerting.notifier.channels.join(", ") : "nenhum canal configurado (só log)"}`);

// O monitor roda no processo do app para perceber quando o worker para.
const monitor = startMonitor(ctx, alerting.manager);
if (alerting.notifier.channels.length) {
  // aviso de reinício: reinícios repetidos indicam que o app está caindo
  alerting.notifier.send(`WeDeals · ${alerting.instance}\n\nℹ️ Servidor iniciado.`).catch((e) => console.error(`[alerta] ${(e as Error).message}`));
}

// Encerramento limpo (docker stop / systemd): termina as requisições em andamento e fecha o banco.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, async () => {
    monitor.stop();
    await app.close();
    ctx.repo.db.close();
    process.exit(0);
  });
}
