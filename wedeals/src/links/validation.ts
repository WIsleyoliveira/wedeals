import type { Marketplace } from "../domain/types";

/** Domínios oficiais por marketplace. Qualquer outro domínio é recusado (proteção contra links falsos/SSRF). */
export const OFFICIAL_DOMAINS: Record<Marketplace, string[]> = {
  mercadolivre: ["mercadolivre.com.br", "mercadolivre.com", "mercadolibre.com", "meli.la"],
  shopee: ["shopee.com.br", "shp.ee", "s.shopee.com.br"],
  shein: ["shein.com", "shein.com.br", "onelink.shein.com", "shein.top"],
};

function hostMatches(host: string, domain: string) {
  return host === domain || host.endsWith("." + domain);
}

export interface LinkCheck {
  ok: boolean;
  reason?: string;
  url?: URL;
}

export function parseHttpsUrl(raw: string): LinkCheck {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return { ok: false, reason: "URL inválida" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "somente https é aceito" };
  if (u.username || u.password) return { ok: false, reason: "URL com credenciais embutidas" };
  if (u.port && u.port !== "443") return { ok: false, reason: "porta não permitida" };
  return { ok: true, url: u };
}

/**
 * Valida um link de afiliado/produto: https, domínio oficial do marketplace (ou rede parceira
 * configurada pela WAPE em AFFILIATE_EXTRA_DOMAINS).
 */
export function validateMarketplaceLink(raw: string, marketplace: Marketplace, extraDomains: string[] = []): LinkCheck {
  const base = parseHttpsUrl(raw);
  if (!base.ok || !base.url) return base;
  const host = base.url.hostname.toLowerCase();
  const allowed = [...OFFICIAL_DOMAINS[marketplace], ...extraDomains];
  if (!allowed.some((d) => hostMatches(host, d))) {
    return { ok: false, reason: `domínio ${host} não é oficial para ${marketplace}` };
  }
  return base;
}

/** Imagens só são aceitas de CDNs dos próprios marketplaces (imagem oficial do anúncio). */
export const IMAGE_DOMAINS = [
  "mlstatic.com",
  "susercontent.com",
  "shopee.com.br",
  "ltwebstatic.com",
  "shein.com",
];

export function isAuthorizedImage(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const c = parseHttpsUrl(raw);
  if (!c.ok || !c.url) return false;
  const host = c.url.hostname.toLowerCase();
  return IMAGE_DOMAINS.some((d) => hostMatches(host, d));
}
