# Integrações de marketplaces — Mercado Livre, Shopee, SHEIN

O AliExpress foi removido do escopo. Nenhum endpoint ou credencial foi inventado: onde não há API
oficial confirmada, o WeDeals usa **importação de links oficiais** e a **Central de ofertas aguardando
vinculação de link**.

| Marketplace | Busca de ofertas | Link de afiliado | Comissões | Adapter |
|---|---|---|---|---|
| **Shopee** | Shopee Affiliate Open API (GraphQL, `productOfferV2`) | Mesma API (`generateShortLink`) | Relatório do painel (CSV) / API de conversões | `ShopeeAffiliateAdapter` — desligado até existir `SHOPEE_APP_ID` + `SHOPEE_APP_SECRET` |
| **Mercado Livre** | API oficial de itens (requer app + OAuth) | **Sem API pública confirmada** — gerador de links do painel de afiliados; importado no WeDeals | Relatório do painel (CSV) | `MercadoLivreAdapter` — busca só com `ML_ACCESS_TOKEN`; link sempre por importação |
| **SHEIN** | **Sem API pública confirmada** | Portal SHEIN Afiliados (br.shein.com/affiliate) ou rede parceira (Awin / Lomadee citadas; **confirmar no painel da rede** se há API de produtos/links) | Relatório do portal/rede (CSV) | `SheinImportAdapter` — somente importação |

## Shopee Affiliate Open API

- Endpoint Brasil citado por SDKs da comunidade: `https://open-api.affiliate.shopee.com.br/graphql`
  **(confirmar no painel Open API após aprovação)**.
- Assinatura: `Authorization: SHA256 Credential={AppId}, Timestamp={ts}, Signature={sha256(AppId+ts+payload+Secret)}`
  **(confirmar na documentação do painel)**. O adapter isola isso em `shopeeSignature()` com teste.
- Credenciais: cadastro no programa de afiliados Shopee BR → aprovação manual → AppID/Secret.
- Erro `10030` = limite de requisições: o worker respeita cotas via `QuotaManager`.

## Mercado Livre

- Programa de Afiliados e Criadores; links gerados em *Ferramentas → Gerador de link* ou extensão oficial.
- Só links gerados pelo painel são comissionados. O WeDeals **nunca monta link de afiliado “na mão”**.
- Fluxo: oferta encontrada → status `awaiting_link` → admin cola o link gerado (ou importa CSV em lote) → segue o pipeline.

## SHEIN

- Inscrição: portal oficial br.shein.com (página de afiliados) ou redes parceiras.
- Fluxo: importação CSV/JSON de produtos com link oficial (exportado do portal/rede) **ou**
  cadastro do produto e vinculação posterior do link na Central de vinculação.
- Validação: o link precisa pertencer a domínios oficiais (`shein.com`, `shein.com.br`, `onelink.shein.com`
  e domínios de redes configurados em `AFFILIATE_EXTRA_DOMAINS`). Qualquer outro domínio é rejeitado.

## Fontes

- https://br.shein.com/affiliate-a-427.html
- https://proafiliados.com/guia/shein-afiliados (secundária)
- https://simplesmentedescobri.com.br/afiliado-shein-como-ser-passo-a-passo/ (secundária)
- https://github.com/gregojoao/shopee-affiliate (SDK da comunidade)
- https://help.shopee.sg/10/article/191702-API-Access
- https://mercadolivre.com.br/l/afiliados-home
- https://www.mercadolivre.com.br/l/afiliados-gerar-link
