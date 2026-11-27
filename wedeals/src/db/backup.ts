import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import type { Fetcher } from "../marketplaces/adapter";
import { AlertManager, alertConfigFromEnv, buildNotifier, memoryStore } from "../ops/alerts";
import { putObject, s3ConfigFromEnv, type S3Config } from "../ops/s3";

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

/** Envia a cópia comprimida para o bucket externo. A retenção lá fica a cargo da regra de ciclo de vida do bucket. */
export async function uploadBackup(file: string, s3: S3Config, fetcher: Fetcher = fetch, now = new Date()): Promise<string> {
  const key = `${s3.prefix}${basename(file)}.gz`;
  await putObject(s3, key, gzipSync(readFileSync(file)), "application/gzip", fetcher, now);
  return key;
}

export interface BackupRunDeps {
  env: NodeJS.ProcessEnv;
  alerts: AlertManager;
  fetcher?: Fetcher;
  now?: () => Date;
  log?: (line: string) => void;
}

/** Uma rodada: cópia local + envio externo (se configurado); falhas viram alerta, sucesso resolve. */
export async function runBackup(d: BackupRunDeps): Promise<{ file?: string; key?: string; ok: boolean }> {
  const log = d.log ?? console.log;
  const now = d.now ?? (() => new Date());
  const dbPath = d.env.DATABASE_PATH ?? "./data/wedeals.db";
  const dir = d.env.BACKUP_DIR ?? "./backups";
  const keep = Number(d.env.BACKUP_KEEP ?? 28);
  const issues = [];
  let file: string | undefined;
  let key: string | undefined;
  try {
    file = backupDatabase(dbPath, dir, keep, now());
    log(`backup ok: ${file} (${statSync(file).size} bytes)`);
  } catch (e) {
    issues.push({ key: "backup:local", message: `Backup do banco falhou: ${(e as Error).message}` });
  }
  if (file) {
    try {
      const s3 = s3ConfigFromEnv(d.env);
      if (s3) {
        key = await uploadBackup(file, s3, d.fetcher, now());
        log(`backup enviado: ${s3.bucket}/${key}`);
      }
    } catch (e) {
      issues.push({ key: "backup:externo", message: `Envio do backup para o armazenamento externo falhou: ${(e as Error).message}` });
    }
  }
  await d.alerts.update(issues, now());
  return { file, key, ok: issues.length === 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const hours = Number(env.BACKUP_INTERVAL_HOURS ?? 0);
  const acfg = alertConfigFromEnv(env);
  const secrets = [env.ADMIN_TOKEN, env.BACKUP_S3_SECRET_ACCESS_KEY, env.BACKUP_S3_ACCESS_KEY_ID, env.TELEGRAM_BOT_TOKEN].filter((x): x is string => Boolean(x));
  const alerts = new AlertManager(buildNotifier(acfg, secrets), memoryStore(), acfg);
  // configuração externa inválida não derruba o serviço: a cópia local continua e cada rodada alerta o erro
  let external = "sem envio externo";
  try {
    const s3 = s3ConfigFromEnv(env);
    if (s3) external = `externo em ${s3.bucket}/${s3.prefix}`;
  } catch (e) {
    external = `envio externo com configuração inválida (${(e as Error).message})`;
  }
  console.log(`Backup: local em ${env.BACKUP_DIR ?? "./backups"}, ${external}`);

  const run = async () => {
    const r = await runBackup({ env, alerts });
    if (!hours && !r.ok) process.exitCode = 1;
  };
  await run();
  if (hours > 0) {
    // modo contínuo (serviço "backup" do docker compose)
    const timer = setInterval(run, hours * 60 * 60_000);
    for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => (clearInterval(timer), process.exit(0)));
  }
}
