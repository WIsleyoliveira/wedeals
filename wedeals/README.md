# WeDeals — central inteligente de grupos de promoções (WAPE)

[![CI](https://github.com/WIsleyoliveira/wedeals/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/WIsleyoliveira/wedeals/actions/workflows/ci.yml)

Receita por comissões de afiliados do **Mercado Livre, Shopee e SHEIN**. Sem checkout próprio, sem
chatbot, sem atendimento, sem disparo 1:1, sem captação de telefones. Grupos somente-admin.

- Planejamento técnico: [docs/PLANEJAMENTO_TECNICO.md](docs/PLANEJAMENTO_TECNICO.md)
- Viabilidade WhatsApp: [docs/VIABILIDADE_WHATSAPP.md](docs/VIABILIDADE_WHATSAPP.md)
- Integrações de marketplaces: [docs/INTEGRACOES_MARKETPLACES.md](docs/INTEGRACOES_MARKETPLACES.md)

## Rodar

Requer Node 22+ (usa `node:sqlite`, sem dependências nativas).

```bash
npm install
cp .env.example .env        # defina ADMIN_TOKEN (mín. 24 caracteres)
node --env-file=.env --import tsx src/db/seed.ts      # opcional: dados DEMO marcados
node --env-file=.env --import tsx src/server/main.ts  # API + dashboard em http://127.0.0.1:3100
node --env-file=.env --import tsx src/scheduler/worker.ts  # Mega Brain contínuo (24h)
```

## Testes

```bash
npm test                 # tudo (62 testes)
npm run test:unit
npm run test:integration
npm run test:security
npm run test:e2e         # servidor HTTP real, fluxo completo, sem publicação real
npm run typecheck
```

## Travas de segurança operacional

- `PUBLISH_ENABLED=false` (padrão): Telegram entra em *dry-run*; nada é enviado.
- WhatsApp sempre em **publicação assistida** — o admin envia e confirma.
- Provedores não oficiais de WhatsApp não estão implementados (teste automatizado garante).
- Links aceitos apenas de domínios oficiais dos marketplaces (ou redes parceiras configuradas).
- Cliques contados de forma agregada por hora, sem IP nem dados pessoais.
