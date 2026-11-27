import { loadConfig } from "../config";
import { buildContext } from "../context";
import { buildApp } from "./app";

const cfg = loadConfig();
const ctx = buildContext(cfg);
const app = buildApp(ctx);
await app.listen({ port: cfg.port, host: "127.0.0.1" });
console.log(`WeDeals em http://127.0.0.1:${cfg.port} — publicação real ${cfg.publishEnabled ? "LIBERADA" : "desligada (PUBLISH_ENABLED=false)"}`);
