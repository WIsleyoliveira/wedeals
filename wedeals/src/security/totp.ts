import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Verificação em duas etapas por app autenticador (TOTP, RFC 6238: HMAC-SHA1, 30 s, 6 dígitos),
 * compatível com Google Authenticator, Microsoft Authenticator, 1Password, Authy etc.
 */
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("segredo base32 inválido");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Segredo novo de 160 bits (tamanho recomendado para SHA-1). */
export const newTotpSecret = () => base32Encode(randomBytes(20));

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const totpStep = (at: Date) => Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);

/**
 * Confere o código aceitando ±1 passo (relógio do celular um pouco adiantado/atrasado).
 * Devolve o passo usado, para impedir reuso do mesmo código (`afterStep`), ou null.
 */
export function verifyTotp(secretB32: string, code: string, at: Date, afterStep = -1): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretB32);
  const now = totpStep(at);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= afterStep) continue;
    const expected = Buffer.from(hotp(key, step));
    if (timingSafeEqual(expected, Buffer.from(c))) return step;
  }
  return null;
}

export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${q}`;
}

// ---------- Códigos de recuperação (uso único) ----------
const RC_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** 10 códigos no formato xxxxx-xxxxx; só o hash é guardado. */
export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const b = randomBytes(10);
    const s = Array.from(b, (x) => RC_ALPHABET[x % RC_ALPHABET.length]).join("");
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

export const normalizeRecoveryCode = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
export const recoveryCodeHash = (s: string) => createHash("sha256").update(`wedeals-rc:${normalizeRecoveryCode(s)}`).digest("hex");
