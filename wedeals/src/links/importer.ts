import { z } from "zod";
import type { Repo } from "../db/repo";
import { MARKETPLACES, type Marketplace } from "../domain/types";
import { isAuthorizedImage, validateMarketplaceLink } from "./validation";

/** Parser CSV simples com suporte a aspas (RFC 4180 básico). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === "," || c === ";") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ""));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => h.trim().toLowerCase());
  return nonEmpty.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const num = (v: unknown) => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(String(v).replace(/[R$\s]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
};

export const ImportRowSchema = z.object({
  marketplace: z.enum(MARKETPLACES),
  external_id: z.string().min(1).max(100),
  title: z.string().min(3).max(300),
  url: z.string().max(2000),
  affiliate_url: z.string().max(2000).optional().or(z.literal("")),
  image_url: z.string().max(2000).optional().or(z.literal("")),
  price: z.preprocess(num, z.number().positive().max(1_000_000)),
  original_price: z.preprocess(num, z.number().positive().max(1_000_000).optional()),
  category: z.string().min(1).max(80).default("geral"),
  seller_name: z.string().max(120).optional(),
  seller_reputation: z.preprocess(num, z.number().min(0).max(1).optional()),
  official_store: z.preprocess((v) => ["1", "true", "sim", "yes"].includes(String(v ?? "").toLowerCase()), z.boolean()),
  commission_rate: z.preprocess(num, z.number().min(0).max(1).optional()),
  coupon_code: z.string().max(40).optional().or(z.literal("")),
  coupon_discount: z.preprocess(num, z.number().min(0).optional()),
});

export interface ImportResult {
  imported: number;
  errors: { row: number; error: string }[];
}

/** Importa ofertas com links oficiais (CSV/JSON exportados dos painéis de afiliados). */
export function importOffers(repo: Repo, rows: Record<string, unknown>[], now: Date, extraDomains: string[] = []): ImportResult {
  const out: ImportResult = { imported: 0, errors: [] };
  rows.slice(0, 5000).forEach((raw, idx) => {
    const parsed = ImportRowSchema.safeParse(raw);
    if (!parsed.success) {
      out.errors.push({ row: idx + 1, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      return;
    }
    const r = parsed.data;
    const productCheck = validateMarketplaceLink(r.url, r.marketplace, extraDomains);
    if (!productCheck.ok) return void out.errors.push({ row: idx + 1, error: `url: ${productCheck.reason}` });
    let affiliate: string | null = null;
    if (r.affiliate_url) {
      const c = validateMarketplaceLink(r.affiliate_url, r.marketplace, extraDomains);
      if (!c.ok) return void out.errors.push({ row: idx + 1, error: `affiliate_url: ${c.reason}` });
      affiliate = c.url!.toString();
    }
    repo.upsertOffer(
      {
        marketplace: r.marketplace,
        externalId: r.external_id,
        title: r.title,
        url: productCheck.url!.toString(),
        imageUrl: r.image_url && isAuthorizedImage(r.image_url) ? r.image_url : null,
        price: r.price,
        originalPrice: r.original_price ?? null,
        category: r.category,
        sellerName: r.seller_name ?? null,
        sellerReputation: r.seller_reputation ?? null,
        officialStore: r.official_store,
        inStock: true,
        commissionRate: r.commission_rate ?? null,
        couponCode: r.coupon_code || null,
        couponDiscount: r.coupon_discount ?? null,
        affiliateUrl: affiliate,
      },
      now,
    );
    out.imported++;
  });
  repo.incrCounter("researched", now, out.imported);
  return out;
}

/** Vincula um link oficial a uma oferta que aguardava link (Central de vinculação). */
export function linkAffiliateUrl(
  repo: Repo,
  offerId: number,
  url: string,
  now: Date,
  extraDomains: string[] = [],
): { ok: boolean; error?: string } {
  const offer = repo.getOffer(offerId);
  if (!offer) return { ok: false, error: "oferta não encontrada" };
  const c = validateMarketplaceLink(url, offer.marketplace as Marketplace, extraDomains);
  if (!c.ok) return { ok: false, error: c.reason };
  repo.setAffiliateUrl(offerId, c.url!.toString(), now);
  if (offer.status === "awaiting_link") repo.updateOfferEvaluation(offerId, { status: "approved" }, now);
  repo.audit("link.attached", { offerId }, now);
  return { ok: true };
}
