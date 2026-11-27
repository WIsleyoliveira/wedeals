import { describe, expect, it, vi } from "vitest";
import { acceptHook, generateHook, renderMessage, sanitizeText } from "../../src/messages/generator";
import { isAuthorizedImage, validateMarketplaceLink } from "../../src/links/validation";
import { parseCsv } from "../../src/links/importer";
import { ShopeeAffiliateAdapter, shopeeSignature } from "../../src/marketplaces/shopee";
import { MercadoLivreAdapter } from "../../src/marketplaces/mercadolivre";
import { SheinImportAdapter } from "../../src/marketplaces/shein";
import { QuotaManager } from "../../src/scheduler/quota";
import { T0, makeCtx, offer } from "../helpers";
import { createHash } from "node:crypto";

describe("gerador de mensagens", () => {
  it("renderiza preço, desconto, cupom, marketplace e link", () => {
    const m = renderMessage({ offer: offer({ couponCode: "OFF10" }), link: "https://wedeals.test/r/abcdef" }).replace(/\u00a0/g, " ");
    expect(m).toContain("R$ 100,00");
    expect(m).toContain("-33%");
    expect(m).toContain("OFF10");
    expect(m).toContain("Shopee");
    expect(m).toContain("https://wedeals.test/r/abcdef");
  });
  it("aceita template do grupo", () => {
    expect(renderMessage({ offer: offer(), link: "L", template: "{titulo} | {preco} | {link} | {desconhecido}" }).replace(/\u00a0/g, " ")).toBe(
      "Produto teste | R$ 100,00 | L | {desconhecido}",
    );
  });
  it("descarta chamada da IA com números, links ou promessas (anti-alucinação)", () => {
    expect(acceptHook("Só hoje 50% off")).toBeNull();
    expect(acceptHook("Veja em https://x.com")).toBeNull();
    expect(acceptHook("Frete grátis garantido")).toBeNull();
    expect(acceptHook('"Seu fone novo chegou"')).toBe("Seu fone novo chegou");
  });
  it("sanitiza marcação e controle", () => {
    expect(sanitizeText("*neg*\u0000rito_ ~x~")).toBe("neg rito x");
  });
  it("sem IA usa chamada fixa", async () => {
    const ai = { name: "fake", complete: vi.fn().mockResolvedValue("Preço de 10 reais") };
    expect(await generateHook(ai, offer())).toBeNull();
  });
});

describe("validação de links", () => {
  it("aceita domínios oficiais e subdomínios", () => {
    expect(validateMarketplaceLink("https://produto.mercadolivre.com.br/MLB-1", "mercadolivre").ok).toBe(true);
    expect(validateMarketplaceLink("https://s.shopee.com.br/abc", "shopee").ok).toBe(true);
    expect(validateMarketplaceLink("https://onelink.shein.com/x", "shein").ok).toBe(true);
  });
  it("recusa domínio falso, http, credenciais, porta e esquemas perigosos", () => {
    expect(validateMarketplaceLink("https://mercadolivre.com.br.golpe.com/x", "mercadolivre").ok).toBe(false);
    expect(validateMarketplaceLink("https://shopee.com.br/x", "shein").ok).toBe(false);
    expect(validateMarketplaceLink("http://shopee.com.br/x", "shopee").ok).toBe(false);
    expect(validateMarketplaceLink("https://u:p@shopee.com.br/x", "shopee").ok).toBe(false);
    expect(validateMarketplaceLink("https://shopee.com.br:8443/x", "shopee").ok).toBe(false);
    expect(validateMarketplaceLink("javascript:alert(1)", "shopee").ok).toBe(false);
  });
  it("aceita rede parceira apenas se configurada", () => {
    expect(validateMarketplaceLink("https://www.awin1.com/cread.php?x", "shein").ok).toBe(false);
    expect(validateMarketplaceLink("https://www.awin1.com/cread.php?x", "shein", ["awin1.com"]).ok).toBe(true);
  });
  it("imagens só de CDNs dos marketplaces", () => {
    expect(isAuthorizedImage("https://http2.mlstatic.com/a.webp")).toBe(true);
    expect(isAuthorizedImage("https://imgur.com/a.png")).toBe(false);
    expect(isAuthorizedImage(null)).toBe(false);
  });
});

describe("CSV", () => {
  it("lê aspas, vírgulas internas e ponto e vírgula", () => {
    const rows = parseCsv('a,b\n"x, y","z ""q"""\n\n1;2\n');
    expect(rows).toEqual([{ a: "x, y", b: 'z "q"' }, { a: "1", b: "2" }]);
  });
});

describe("adapters", () => {
  it("assinatura Shopee = sha256(appId+timestamp+payload+secret)", () => {
    const expected = createHash("sha256").update("id1700{}sec").digest("hex");
    expect(shopeeSignature("id", 1700, "{}", "sec")).toBe(expected);
  });
  it("Shopee sem credenciais não faz chamadas", async () => {
    const f = vi.fn();
    const a = new ShopeeAffiliateAdapter({ appId: "", appSecret: "", apiUrl: "https://x" }, f);
    expect(await a.search("x", 5)).toEqual([]);
    expect(await a.generateAffiliateLink("https://shopee.com.br/x")).toBeNull();
    expect(f).not.toHaveBeenCalled();
    expect(a.status().configured).toBe(false);
  });
  it("Shopee com credenciais envia GraphQL assinado e mapeia ofertas", async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { productOfferV2: { nodes: [{ itemId: 9, productName: "P", priceMin: "80", priceDiscountRate: 20, commissionRate: "0.1", productLink: "https://shopee.com.br/p", offerLink: "https://s.shopee.com.br/o", ratingStar: "4.5", productCatIds: [11] }] } } })),
    );
    const a = new ShopeeAffiliateAdapter({ appId: "APP", appSecret: "SEC", apiUrl: "https://api.test/graphql" }, f, () => T0);
    const [o] = await a.search("fone", 5);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://api.test/graphql");
    expect(init.headers.authorization).toMatch(/^SHA256 Credential=APP, Timestamp=\d+, Signature=[a-f0-9]{64}$/);
    expect(o).toMatchObject({ marketplace: "shopee", externalId: "9", price: 80, originalPrice: 100, affiliateUrl: "https://s.shopee.com.br/o", sellerReputation: 0.9 });
  });
  it("Mercado Livre nunca gera link sozinho; SHEIN é só importação", async () => {
    expect(await new MercadoLivreAdapter("tok", vi.fn()).generateAffiliateLink()).toBeNull();
    const s = new SheinImportAdapter();
    expect(s.status().mode).toBe("import");
    expect(await s.search()).toEqual([]);
  });
});

describe("cotas", () => {
  it("bloqueia ao exceder limite por hora", () => {
    const { ctx } = makeCtx();
    const q = new QuotaManager(ctx.repo, { p: { perHour: 2, perDay: 10 } });
    expect(q.tryConsume("p", T0)).toBe(true);
    expect(q.tryConsume("p", T0)).toBe(true);
    expect(q.tryConsume("p", T0)).toBe(false);
    expect(q.tryConsume("p", new Date(T0.getTime() + 3_600_000))).toBe(true);
  });
});
