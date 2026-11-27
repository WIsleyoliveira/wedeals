import type { RawOffer } from "../domain/types";
import type { AdapterStatus, Fetcher, MarketplaceAdapter } from "./adapter";

/**
 * Mercado Livre: busca pela API oficial de itens (exige app + token OAuth do portal de desenvolvedores).
 * Link de afiliado: NÃO há API pública confirmada — sempre via gerador do painel de afiliados e importação.
 */
export class MercadoLivreAdapter implements MarketplaceAdapter {
  readonly marketplace = "mercadolivre" as const;
  constructor(
    private accessToken: string,
    private fetcher: Fetcher = fetch,
  ) {}

  status(): AdapterStatus {
    const configured = Boolean(this.accessToken);
    return {
      marketplace: "mercadolivre",
      mode: "official_api",
      searchEnabled: configured,
      affiliateLinkGeneration: "manual_import",
      configured,
      note: configured
        ? "Busca oficial ativa; links de afiliado via Gerador de link do painel (importação)"
        : "Aguardando ML_ACCESS_TOKEN; links de afiliado sempre por importação",
    };
  }

  private async get(path: string): Promise<any> {
    const res = await this.fetcher(`https://api.mercadolibre.com${path}`, {
      headers: { authorization: `Bearer ${this.accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Mercado Livre HTTP ${res.status}`);
    return res.json();
  }

  async search(keyword: string, limit: number): Promise<RawOffer[]> {
    if (!this.accessToken) return [];
    const data = await this.get(`/sites/MLB/search?q=${encodeURIComponent(keyword)}&limit=${Math.min(limit, 50)}`);
    return (data.results ?? []).map(
      (r: any): RawOffer => ({
        marketplace: "mercadolivre",
        externalId: String(r.id),
        title: String(r.title),
        url: String(r.permalink),
        imageUrl: r.thumbnail ? String(r.thumbnail).replace(/^http:/, "https:") : null,
        price: Number(r.price),
        originalPrice: r.original_price != null ? Number(r.original_price) : null,
        category: r.category_id ? `ml:${r.category_id}` : "geral",
        sellerName: r.seller?.nickname ?? null,
        sellerReputation: null,
        officialStore: r.official_store_id != null,
        inStock: Number(r.available_quantity ?? 1) > 0,
        commissionRate: null,
        affiliateUrl: null,
      }),
    );
  }

  async refresh(externalId: string) {
    if (!this.accessToken) return null;
    const r = await this.get(`/items/${encodeURIComponent(externalId)}`);
    return { price: Number(r.price), inStock: r.status === "active" && Number(r.available_quantity ?? 1) > 0 };
  }

  async generateAffiliateLink(): Promise<null> {
    return null; // sempre importação de link oficial do painel
  }
}
