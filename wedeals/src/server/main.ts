import { loadConfig } from "../config";
import { buildContext } from "../context";
import { buildApp } from "./app";

const cfg = loadConfig();
const ctx = buildContext(cfg);
const app = buildApp(ctx);
await app.listen({ port: cfg.port, host: cfg.host });
console.log(`WeDeals em http://${cfg.host}:${cfg.port} — publicação real ${cfg.publishEnabled ? "LIBERADA" : "desligada (PUBLISH_ENABLED=false)"}`);

// Encerramento limpo (docker stop / systemd): termina as requisições em andamento e fecha o banco.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, async () => {
    await app.close();
    ctx.repo.db.close();
    process.exit(0);
  });
}
