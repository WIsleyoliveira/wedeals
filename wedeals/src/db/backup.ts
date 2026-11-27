import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const PREFIX = "wedeals-";
const SUFFIX = ".db";

/**
 * Cópia consistente do banco com `VACUUM INTO` (funciona com o servidor e o worker gravando, em WAL)
 * e remoção das cópias mais antigas, mantendo `keep` arquivos.
 */
export function backupDatabase(dbPath: string, dir: string, keep: number, now = new Date()): string {
  mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"); // 20261127T153000Z
  const target = join(dir, `${PREFIX}${stamp}${SUFFIX}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
  pruneBackups(dir, keep);
  return target;
}

export function pruneBackups(dir: string, keep: number): string[] {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .sort(); // o carimbo ISO ordena cronologicamente
  const removed = files.slice(0, Math.max(0, files.length - Math.max(1, keep)));
  for (const f of removed) rmSync(join(dir, f));
  return removed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dbPath = process.env.DATABASE_PATH ?? "./data/wedeals.db";
  const dir = process.env.BACKUP_DIR ?? "./backups";
  const keep = Number(process.env.BACKUP_KEEP ?? 28);
  const hours = Number(process.env.BACKUP_INTERVAL_HOURS ?? 0);

  const run = () => {
    try {
      const f = backupDatabase(dbPath, dir, keep);
      console.log(`backup ok: ${f} (${statSync(f).size} bytes)`);
    } catch (e) {
      console.error(`backup falhou: ${(e as Error).message}`);
      if (!hours) process.exitCode = 1;
    }
  };

  run();
  if (hours > 0) {
    // modo contínuo (serviço "backup" do docker compose)
    const timer = setInterval(run, hours * 60 * 60_000);
    for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => (clearInterval(timer), process.exit(0)));
  }
}
