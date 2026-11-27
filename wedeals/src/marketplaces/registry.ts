import type { AppConfig } from "../config";
import type { Marketplace } from "../domain/types";
import type { Fetcher, MarketplaceAdapter } from "./adapter";
import { MercadoLivreAdapter } from "./mercadolivre";
import { SheinImportAdapter } from "./shein";
import { ShopeeAffiliateAdapter } from "./shopee";

export type AdapterRegistry = Record<Marketplace, MarketplaceAdapter>;

export function buildAdapters(cfg: AppConfig, fetcher: Fetcher = fetch): AdapterRegistry {
  return {
    mercadolivre: new MercadoLivreAdapter(cfg.mlAccessToken, fetcher),
    shopee: new ShopeeAffiliateAdapter(cfg.shopee, fetcher),
    shein: new SheinImportAdapter(),
  };
}
