import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, newRecoveryCodes, newTotpSecret, otpauthUri, recoveryCodeHash, verifyTotp } from "../../src/security/totp";

// RFC 4226 (HOTP) e RFC 6238 (TOTP), segredo ASCII "12345678901234567890"
const RFC_SECRET = Buffer.from("12345678901234567890");

describe("TOTP", () => {
  it("HOTP: vetores do RFC 4226", () => {
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, i) => expect(hotp(RFC_SECRET, i)).toBe(code));
  });

  it("TOTP: vetores SHA-1 do RFC 6238 (8 dígitos)", () => {
    const cases: [number, string][] = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]];
    for (const [t, code] of cases) expect(hotp(RFC_SECRET, Math.floor(t / 30), 8)).toBe(code);
  });

  it("base32 ida e volta, e segredo de 160 bits", () => {
    expect(base32Encode(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode("gezd gnbv-gy3tqojqgezdgnbvgy3tqojq")).toEqual(RFC_SECRET);
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    expect(() => base32Decode("1189")).toThrow();
  });

  it("aceita ±30 s, recusa fora da janela, formato inválido e reuso", () => {
    const secret = base32Encode(RFC_SECRET);
    const at = new Date(59_000); // passo 1 → 287082
    expect(verifyTotp(secret, "287082", at)).toBe(1);
    expect(verifyTotp(secret, "287 082", at)).toBe(1);
    expect(verifyTotp(secret, "755224", at)).toBe(0); // passo anterior, ainda aceito
    expect(verifyTotp(secret, "969429", at)).toBeNull(); // dois passos à frente
    expect(verifyTotp(secret, "28708", at)).toBeNull();
    expect(verifyTotp(secret, "abcdef", at)).toBeNull();
    expect(verifyTotp(secret, "287082", at, 1)).toBeNull(); // já usado
  });

  it("URI otpauth para o QR code", () => {
    const u = new URL(otpauthUri("GEZDGNBV", "maria", "WeDeals WAPE"));
    expect(u.protocol).toBe("otpauth:");
    expect(u.host).toBe("totp");
    expect(decodeURIComponent(u.pathname)).toBe("/WeDeals WAPE:maria");
    expect(Object.fromEntries(u.searchParams)).toEqual({ secret: "GEZDGNBV", issuer: "WeDeals WAPE", algorithm: "SHA1", digits: "6", period: "30" });
  });

  it("códigos de recuperação: 10 únicos, hash ignora formatação", () => {
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(codes[0]).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    expect(recoveryCodeHash(codes[0].toUpperCase().replace("-", " "))).toBe(recoveryCodeHash(codes[0]));
  });
});
