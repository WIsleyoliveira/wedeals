import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config";
import { openDatabase } from "../../src/db/database";
import { backupDatabase, pruneBackups } from "../../src/db/backup";
import { buildApp } from "../../src/server/app";
import { TOKEN, makeCtx } from "../helpers";

describe("deploy", () => {
  it("config: host e proxy com padrões seguros", () => {
    const d = loadConfig({});
    expect(d.host).toBe("127.0.0.1");
    expect(d.trustProxyHops).toBe(0);
    const c = loadConfig({ HOST: "0.0.0.0", TRUST_PROXY_HOPS: "1" });
    expect(c.host).toBe("0.0.0.0");
    expect(c.trustProxyHops).toBe(1);
    expect(loadConfig({ TRUST_PROXY_HOPS: "abc" }).trustProxyHops).toBe(0);
    expect(loadConfig({ TRUST_PROXY_HOPS: "-3" }).trustProxyHops).toBe(0);
  });

  it("sem proxy confiável, X-Forwarded-For é ignorado (bloqueio por força bruta não é burlável)", async () => {
    const { ctx } = makeCtx();
    const app = buildApp(ctx);
    const codes = [];
    for (let i = 0; i < 12; i++)
      codes.push((await app.inject({ url: "/api/dashboard", headers: { authorization: `Bearer x${i}`, "x-forwarded-for": `10.0.0.${i}` } })).statusCode);
    expect(codes.at(-1)).toBe(429);
  });

  it("atrás do proxy, o limite é por cliente real e não pelo IP do proxy", async () => {
    const { ctx } = makeCtx({ cfg: { trustProxyHops: 1 } });
    const app = buildApp(ctx);
    for (let i = 0; i < 12; i++) await app.inject({ url: "/api/dashboard", headers: { authorization: `Bearer x${i}`, "x-forwarded-for": "203.0.113.9" } });
    const other = await app.inject({ url: "/api/dashboard", headers: { authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "198.51.100.7" } });
    expect(other.statusCode).toBe(200);
  });

  it("backup gera cópia consistente e mantém só as N mais recentes", () => {
    const dir = mkdtempSync(join(tmpdir(), "wedeals-bkp-"));
    const dbPath = join(dir, "data", "wedeals.db");
    const db = openDatabase(dbPath);
    db.prepare("INSERT INTO settings (key, value) VALUES ('k', 'v')").run();
    const out = join(dir, "backups");
    const files = [0, 1, 2, 3].map((h) => backupDatabase(dbPath, out, 2, new Date(Date.UTC(2026, 10, 27, h))));
    db.close();
    expect(readdirSync(out).sort()).toEqual(["wedeals-20261127T020000Z.db", "wedeals-20261127T030000Z.db"]);
    const copy = new DatabaseSync(files[3], { readOnly: true });
    expect(copy.prepare("SELECT value FROM settings WHERE key='k'").get()).toEqual({ value: "v" });
    copy.close();
  });

  it("limpeza de backups não apaga outros arquivos", () => {
    const dir = mkdtempSync(join(tmpdir(), "wedeals-prune-"));
    for (const f of ["wedeals-20260101T000000Z.db", "wedeals-20260102T000000Z.db", "notas.txt"]) writeFileSync(join(dir, f), "");
    expect(pruneBackups(dir, 1)).toEqual(["wedeals-20260101T000000Z.db"]);
    expect(readdirSync(dir).sort()).toEqual(["notas.txt", "wedeals-20260102T000000Z.db"]);
  });
});
