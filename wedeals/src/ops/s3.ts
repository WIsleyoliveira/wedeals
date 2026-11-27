import { createHash, createHmac } from "node:crypto";
import type { Fetcher } from "../marketplaces/adapter";

/**
 * Envio de arquivos para armazenamento compatível com S3 (AWS S3, Cloudflare R2, Backblaze B2, MinIO),
 * assinado com AWS Signature V4. Sem SDK: só `node:crypto` e `fetch`.
 */
export interface S3Config {
  endpoint: string; // ex.: https://<conta>.r2.cloudflarestorage.com
  region: string; // "auto" no R2; região do bucket no S3/B2
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string; // ex.: "wedeals/"
}

const sha256hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

/** Codificação de caminho do S3: cada segmento em RFC 3986, mantendo as barras. */
export const encodeS3Path = (path: string) =>
  path
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");

export interface SignInput {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  headers: Record<string, string>; // sem host/x-amz-date, que são adicionados aqui
  payloadHash: string;
  date: Date;
  service?: string;
}

/** Devolve os cabeçalhos a enviar (inclui Authorization, x-amz-date e x-amz-content-sha256). */
export function signV4(i: SignInput): Record<string, string> {
  const service = i.service ?? "s3";
  const amzDate = i.date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20130524T000000Z
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(Object.entries(i.headers).map(([k, v]) => [k.toLowerCase(), v])),
    host: i.url.host,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": i.payloadHash,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...i.url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [i.method, i.url.pathname, query, canonicalHeaders, signedHeaders, i.payloadHash].join("\n");
  const scope = `${day}/${i.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${i.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, i.region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete headers.host; // o fetch define o Host
  return headers;
}

/** URL no estilo de caminho (endpoint/bucket/chave), aceito por R2, B2, MinIO e S3. */
export function objectUrl(cfg: S3Config, key: string): URL {
  const base = cfg.endpoint.replace(/\/+$/, "");
  return new URL(`${base}/${encodeS3Path(cfg.bucket)}/${encodeS3Path(key)}`);
}

export async function putObject(
  cfg: S3Config,
  key: string,
  body: Buffer,
  contentType: string,
  fetcher: Fetcher = fetch,
  now = new Date(),
): Promise<void> {
  const url = objectUrl(cfg, key);
  const headers = signV4({
    method: "PUT",
    url,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    headers: { "content-type": contentType },
    payloadHash: sha256hex(body),
    date: now,
  });
  const res = await fetcher(url.toString(), { method: "PUT", headers, body: new Uint8Array(body), signal: AbortSignal.timeout(120_000) });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    throw new Error(`envio para o bucket falhou: HTTP ${res.status}${code ? ` (${code})` : ""}`);
  }
}

/** Valida a configuração; devolve null quando o envio externo não foi configurado. */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv): S3Config | null {
  const endpoint = (env.BACKUP_S3_ENDPOINT ?? "").trim();
  const bucket = (env.BACKUP_S3_BUCKET ?? "").trim();
  const accessKeyId = (env.BACKUP_S3_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (env.BACKUP_S3_SECRET_ACCESS_KEY ?? "").trim();
  if (!endpoint && !bucket && !accessKeyId && !secretAccessKey) return null;
  const missing = Object.entries({ BACKUP_S3_ENDPOINT: endpoint, BACKUP_S3_BUCKET: bucket, BACKUP_S3_ACCESS_KEY_ID: accessKeyId, BACKUP_S3_SECRET_ACCESS_KEY: secretAccessKey })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`backup externo incompleto: faltam ${missing.join(", ")}`);
  const url = new URL(endpoint);
  if (url.protocol !== "https:" && env.BACKUP_S3_ALLOW_HTTP !== "true")
    throw new Error("BACKUP_S3_ENDPOINT precisa usar https (http só com BACKUP_S3_ALLOW_HTTP=true, para testes locais)");
  let prefix = (env.BACKUP_S3_PREFIX ?? "wedeals/").trim().replace(/^\/+/, "");
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return { endpoint, region: (env.BACKUP_S3_REGION ?? "auto").trim() || "auto", bucket, accessKeyId, secretAccessKey, prefix };
}
