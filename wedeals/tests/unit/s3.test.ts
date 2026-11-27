import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encodeS3Path, objectUrl, putObject, s3ConfigFromEnv, signV4 } from "../../src/ops/s3";

// Vetores publicados pela AWS na documentação do Signature V4 para S3 (credenciais de exemplo).
const base = {
  region: "us-east-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  date: new Date("2013-05-24T00:00:00Z"),
};

describe("S3 Signature V4", () => {
  it("GET de exemplo da AWS", () => {
    const h = signV4({
      ...base, method: "GET", url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" }, payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    expect(h.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
    expect(h["x-amz-date"]).toBe("20130524T000000Z");
    expect(h.host).toBeUndefined();
  });

  it("PUT de exemplo da AWS", () => {
    const h = signV4({
      ...base, method: "PUT", url: new URL("https://examplebucket.s3.amazonaws.com/test%24file.text"),
      headers: { date: "Fri, 24 May 2013 00:00:00 GMT", "x-amz-storage-class": "REDUCED_REDUNDANCY" },
      payloadHash: "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    });
    expect(h.authorization).toContain("Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd");
  });

  it("PUT com corpo binário, região auto e chave com espaço: igual ao botocore 1.40", () => {
    const body = Buffer.from("conteudo do backup \x00\x01 gz", "latin1");
    const h = signV4({
      method: "PUT", url: new URL("https://conta.r2.cloudflarestorage.com/bkp/wedeals/prod%20x/wedeals-20261127T150000Z.db.gz"),
      region: "auto", accessKeyId: "AKIDEXEMPLO", secretAccessKey: "segredo/Exemplo+123", headers: { "content-type": "application/gzip" },
      payloadHash: "bdc4109a4e5a051fd36c94c705a8b3e45ad5da626221b1a03a59436a11685a13", date: new Date("2026-11-27T15:00:00Z"),
    });
    expect(createHash("sha256").update(body).digest("hex")).toBe("bdc4109a4e5a051fd36c94c705a8b3e45ad5da626221b1a03a59436a11685a13");
    expect(h.authorization).toContain("Signature=ad30e8419607da1e42f05d3ebe56cd43e352333b9a51f28606acec5c7b7da3f3");
  });

  it("codifica a chave e monta a URL no estilo de caminho", () => {
    expect(encodeS3Path("wedeals/a b$(1).db.gz")).toBe("wedeals/a%20b%24%281%29.db.gz");
    const cfg = { endpoint: "https://conta.r2.cloudflarestorage.com/", region: "auto", bucket: "bkp", accessKeyId: "k", secretAccessKey: "s", prefix: "" };
    expect(objectUrl(cfg, "wedeals/x.db.gz").toString()).toBe("https://conta.r2.cloudflarestorage.com/bkp/wedeals/x.db.gz");
  });

  it("putObject envia PUT assinado e reporta o erro sem expor credenciais", async () => {
    const cfg = { endpoint: "https://s3.exemplo.test", region: "auto", bucket: "bkp", accessKeyId: "AKID", secretAccessKey: "SEGREDO", prefix: "" };
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = async (url: string, init?: RequestInit) => (calls.push({ url, init: init! }), new Response(null, { status: 200 }));
    await putObject(cfg, "wedeals/x.db.gz", Buffer.from("abc"), "application/gzip", ok);
    expect(calls[0].url).toBe("https://s3.exemplo.test/bkp/wedeals/x.db.gz");
    expect(calls[0].init.method).toBe("PUT");
    const hs = calls[0].init.headers as Record<string, string>;
    expect(hs.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/\d{8}\/auto\/s3\/aws4_request/);
    expect(hs["x-amz-content-sha256"]).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(JSON.stringify(hs)).not.toContain("SEGREDO");

    const denied = async () => new Response("<Error><Code>AccessDenied</Code><Message>x</Message></Error>", { status: 403 });
    await expect(putObject(cfg, "k", Buffer.from(""), "application/gzip", denied)).rejects.toThrow("HTTP 403 (AccessDenied)");
  });

  it("configuração: vazia desliga, incompleta ou sem https recusa", () => {
    expect(s3ConfigFromEnv({})).toBeNull();
    expect(() => s3ConfigFromEnv({ BACKUP_S3_BUCKET: "b" })).toThrow(/BACKUP_S3_ENDPOINT.*ACCESS_KEY_ID.*SECRET/);
    const full = { BACKUP_S3_ENDPOINT: "http://minio:9000", BACKUP_S3_BUCKET: "b", BACKUP_S3_ACCESS_KEY_ID: "k", BACKUP_S3_SECRET_ACCESS_KEY: "s" };
    expect(() => s3ConfigFromEnv(full)).toThrow(/https/);
    const c = s3ConfigFromEnv({ ...full, BACKUP_S3_ALLOW_HTTP: "true", BACKUP_S3_PREFIX: "/prod" })!;
    expect(c).toMatchObject({ region: "auto", prefix: "prod/" });
  });
});
