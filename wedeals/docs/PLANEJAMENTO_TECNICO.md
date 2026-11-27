# WeDeals — Planejamento técnico (revisão de escopo oficial)

**Modelo de negócio:** central inteligente de grupos de promoções. Receita = comissões de afiliados
(Mercado Livre, Shopee, SHEIN). Sem checkout próprio. Grupos somente-admin; participantes entram por
convite. Sem chatbot, respostas automáticas, atendimento individual, CRM, disparo 1:1, captação de
telefones ou adição de membros sem autorização — **esses módulos não existem no código**.

## Arquitetura

```
src/
  domain/        tipos e enums (Marketplace = mercadolivre | shopee | shein)
  db/            SQLite (node:sqlite), schema, migrations, repositórios
  marketplaces/  MarketplaceAdapter + Shopee (API oficial), Mercado Livre (API oficial de busca), SHEIN (importação)
  links/         importação de links oficiais, validação de domínio, Central de vinculação
  brain/         Mega Brain: pipeline de 17 etapas, Deal Score, histórico de preço, aprendizado, insights
  ai/            provedores de texto (Ollama/Groq/Gemini grátis, opcionais) + fallback determinístico
  messages/      templates e gerador de mensagens
  groups/        Central de grupos: regras, janelas, limites, anti-repetição
  distribution/  DistributionChannel: AssistedWhatsApp, Telegram (oficial), DryRun — trava PUBLISH_ENABLED
  scheduler/     planejador de fila e worker contínuo (cotas e orçamento)
  analytics/     cliques (redirecionador), comissões, custos, resultado operacional
  security/      autenticação do admin, rate limit, auditoria, sanitização
  server/        API Fastify + dashboard estático
```

## Pipeline do Mega Brain (17 etapas)

1 pesquisar → 2 cupons → 3 validar preço → 4 comparar histórico → 5 classificar → 6 reputação do vendedor
→ 7 potencial de conversão → 8 link de afiliado (gerar ou aguardar vinculação) → 9 mensagem → 10 imagem
autorizada (só a imagem oficial do anúncio) → 11 grupos compatíveis → 12 fila → 13 revalidar → 14 publicar
(oficial) ou preparar assistido → 15 registrar → 16 métricas → 17 aprendizado.

Pesquisa roda 24h (inclusive madrugada) limitada por `QuotaManager` (requisições/provedor/hora e orçamento
diário de IA). Publicação só dentro da janela de cada grupo.

## Deal Score (0–100)

| Componente | Peso | Regra |
|---|---|---|
| Desconto real | 35 | contra a **mediana de 30 dias** do histórico, não contra o “de” anunciado |
| Desconto anunciado confiável | 10 | zerado se o “de” for >25% acima da máxima histórica (desconto inflado) |
| Reputação do vendedor | 15 | reputação/selo oficial; abaixo do mínimo = rejeição |
| Cupom | 10 | cupom válido aplicável |
| Potencial de conversão | 20 | desempenho aprendido da categoria e faixa de preço (agregado) |
| Comissão | 10 | **teto de 10 pontos**: comissão alta nunca compensa oferta ruim |

Rejeições automáticas: sem estoque, preço subiu na revalidação, vendedor abaixo do mínimo, desconto falso.

## Prioridades de entrega

1 pesquisa → 2 links → 3 validação → 4 inteligência → 5 mensagens → 6 grupos → 7 distribuição assistida/autorizada
→ 8 analytics/comissões → 9 custos → 10 segurança. Telegram e portal público são complementares.

## Decisões externas pendentes (WAPE)

- Credenciais Shopee Affiliate Open API, app Mercado Livre, conta SHEIN Afiliados/rede parceira.
- Token de bot do Telegram (opcional).
- Aprovação expressa e por escrito, caso desejem avaliar provedor não oficial de WhatsApp (não recomendado).
- Liberação de publicação real (`PUBLISH_ENABLED=true`).

Ver também [VIABILIDADE_WHATSAPP.md](VIABILIDADE_WHATSAPP.md) e [INTEGRACOES_MARKETPLACES.md](INTEGRACOES_MARKETPLACES.md).
