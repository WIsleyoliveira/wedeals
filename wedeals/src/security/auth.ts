import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

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
  /** Já estourou o limite nesta janela (não conta como tentativa). */
  blocked(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    return Boolean(h && h.resetAt > now && h.count >= this.max);
  }
  private prune(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}

// ---------- Senhas e sessões das contas do dashboard ----------
const scrypt = (pw: string, salt: Buffer, len: number, o: ScryptOptions) =>
  new Promise<Buffer>((res, rej) => scryptCb(pw, salt, len, o, (e, k) => (e ? rej(e) : res(k))));

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 200;
export const SESSION_HOURS = 12;

/** scrypt$N$r$p$sal$hash (base64url). */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw.normalize("NFKC"), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scrypt(pw.normalize("NFKC"), Buffer.from(salt, "base64url"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Hash fixo para gastar o mesmo tempo quando o usuário não existe (não revela quais nomes existem). */
let dummyHash: Promise<string> | undefined;
export const dummyPasswordHash = () => (dummyHash ??= hashPassword(randomBytes(12).toString("hex")));

export function newSessionToken(): { token: string; hash: string } {
  const token = `wds_${randomBytes(32).toString("base64url")}`;
  return { token, hash: sessionTokenHash(token) };
}

export const sessionTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
