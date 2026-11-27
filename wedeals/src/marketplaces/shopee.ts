import { createHash } from "node:crypto";
import type { RawOffer } from "../domain/types";
import type { AdapterStatus, Fetcher, MarketplaceAdapter } from "./adapter";

/**
 * Shopee Affiliate Open API (GraphQL). Endpoint, nomes de campos e formato de assinatura seguem o que é
 * descrito por SDKs da comunidade e precisam ser CONFIRMADOS no painel Open API após aprovação.
 * Sem AppID/Secret o adapter fica desligado e não faz nenhuma chamada.
 */
export function shopeeSignature(appId: string, timestamp: number, payload: string, secret: string): string {
  return createHash("sha256").update(`${appId}${timestamp}${payload}${secret}`).digest("hex");
}

export class ShopeeAffiliateAdapter implements MarketplaceAdapter {
  readonly marketplace = "shopee" as const;
  constructor(
    private cfg: { appId: string; appSecret: string; apiUrl: string },
    private fetcher: Fetcher = fetch,
    private clock: () => Date = () => new Date(),
  ) {}

  private get configured() {
    return Boolean(this.cfg.appId && this.cfg.appSecret);
  }

  status(): AdapterStatus {
    return {
      marketplace: "shopee",
      mode: "official_api",
      searchEnabled: this.configured,
      affiliateLinkGeneration: this.configured ? "api" : "manual_import",
      configured: this.configured,
      note: this.configured
        ? "Shopee Affiliate Open API configurada"
        : "Aguardando SHOPEE_APP_ID e SHOPEE_APP_SECRET (aprovação no programa de afiliados)",
    };
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const payload = JSON.stringify({ query, variables });
    const ts = Math.floor(this.clock().getTime() / 1000);
    const sig = shopeeSignature(this.cfg.appId, ts, payload, this.cfg.appSecret);
    const res = await this.fetcher(this.cfg.apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `SHA256 Credential=${this.cfg.appId}, Timestamp=${ts}, Signature=${sig}`,
      },
      body: payload,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Shopee HTTP ${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: number } }[] };
    if (body.errors?.length) {
      const e = body.errors[0];
      throw new Error(`Shopee API: ${e.extensions?.code ?? ""} ${e.message}`.trim());
    }
    return body.data as T;
  }

  async search(keyword: string, limit: number): Promise<RawOffer[]> {
    if (!this.configured) return [];
    const data = await this.gql<{ productOfferV2: { nodes: any[] } }>(
      `query($keyword:String,$limit:Int){productOfferV2(keyword:$keyword,limit:$limit,sortType:2){nodes{
        itemId productName priceMin priceMax priceDiscountRate commissionRate imageUrl productLink offerLink
        shopName ratingStar shopType productCatIds}}}`,
      { keyword, limit },
    );
    return (data.productOfferV2?.nodes ?? []).map((n) => {
      const price = Number(n.priceMin ?? n.priceMax);
      const discount = Number(n.priceDiscountRate ?? 0) / 100;
      return {
        marketplace: "shopee",
        externalId: String(n.itemId),
        title: String(n.productName),
        url: String(n.productLink),
        imageUrl: n.imageUrl ?? null,
        price,
        originalPrice: discount > 0 && discount < 1 ? Math.round((price / (1 - discount)) * 100) / 100 : null,
        category: Array.isArray(n.productCatIds) ? `shopee:${n.productCatIds[0]}` : "geral",
        sellerName: n.shopName ?? null,
        sellerReputation: n.ratingStar ? Number(n.ratingStar) / 5 : null,
        officialStore: Array.isArray(n.shopType) ? n.shopType.includes(1) : false,
        inStock: true,
        commissionRate: n.commissionRate != null ? Number(n.commissionRate) : null,
        affiliateUrl: n.offerLink ?? null,
      } satisfies RawOffer;
    });
  }

  async refresh(): Promise<null> {
    // A Open API não expõe consulta direta por item de forma documentada publicamente; a revalidação
    // é feita refazendo a busca no ciclo do worker.
    return null;
  }

  async generateAffiliateLink(productUrl: string, subId?: string): Promise<string | null> {
    if (!this.configured) return null;
    const data = await this.gql<{ generateShortLink: { shortLink: string } }>(
      `mutation($url:String!,$subIds:[String]){generateShortLink(input:{originUrl:$url,subIds:$subIds}){shortLink}}`,
      { url: productUrl, subIds: subId ? [subId] : [] },
    );
    return data.generateShortLink?.shortLink ?? null;
  }
}
