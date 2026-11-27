import type { AdapterStatus, MarketplaceAdapter } from "./adapter";

/**
 * SHEIN: sem API pública de afiliados confirmada no Brasil. Ofertas e links entram por importação
 * (portal SHEIN Afiliados ou rede parceira autorizada). Quando a WAPE obtiver acesso a uma API de
 * rede parceira, basta implementar search/generateAffiliateLink aqui.
 */
export class SheinImportAdapter implements MarketplaceAdapter {
  readonly marketplace = "shein" as const;
  status(): AdapterStatus {
    return {
      marketplace: "shein",
      mode: "import",
      searchEnabled: false,
      affiliateLinkGeneration: "manual_import",
      configured: true,
      note: "Importação de links oficiais (portal SHEIN Afiliados / rede parceira). API a confirmar com a rede.",
    };
  }
  async search() {
    return [];
  }
  async refresh() {
    return null;
  }
  async generateAffiliateLink() {
    return null;
  }
}
