import type { Marketplace, RawOffer } from "../domain/types";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface AdapterStatus {
  marketplace: Marketplace;
  /** "official_api": busca e/ou link via API oficial; "import": depende de importação de links oficiais. */
  mode: "official_api" | "import";
  searchEnabled: boolean;
  affiliateLinkGeneration: "api" | "manual_import";
  configured: boolean;
  note: string;
}

export interface MarketplaceAdapter {
  readonly marketplace: Marketplace;
  status(): AdapterStatus;
  /** Pesquisa ofertas. Adapters sem API oficial retornam []. */
  search(keyword: string, limit: number): Promise<RawOffer[]>;
  /** Busca preço/estoque atual para revalidação. null = não suportado/indisponível. */
  refresh(externalId: string, url: string): Promise<Pick<RawOffer, "price" | "inStock"> | null>;
  /** Gera link de afiliado pela API oficial. null = precisa de importação/vinculação manual. */
  generateAffiliateLink(productUrl: string, subId?: string): Promise<string | null>;
}
