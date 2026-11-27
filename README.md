# WeDeals — central inteligente de grupos de promoções (WAPE)

[![CI](https://github.com/WIsleyoliveira/wedeals/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/WIsleyoliveira/wedeals/actions/workflows/ci.yml)

Receita por comissões de afiliados do **Mercado Livre, Shopee e SHEIN**. Sem checkout próprio, sem
chatbot, sem atendimento, sem disparo 1:1, sem captação de telefones. Grupos somente-admin.

- Planejamento técnico: [docs/PLANEJAMENTO_TECNICO.md](wedeals/docs/PLANEJAMENTO_TECNICO.md)
- Viabilidade WhatsApp: [docs/VIABILIDADE_WHATSAPP.md](wedeals/docs/VIABILIDADE_WHATSAPP.md)
- Integrações de marketplaces: [docs/INTEGRACOES_MARKETPLACES.md](wedeals/docs/INTEGRACOES_MARKETPLACES.md)
- Deploy com Docker (servidor, HTTPS, backup externo, alertas): [docs/DEPLOY.md](wedeals/docs/DEPLOY.md)

## Rodar

Requer Node 22+ (usa `node:sqlite`, sem dependências nativas).

```bash
cd wedeals
npm install
cp .env.example .env        # defina ADMIN_TOKEN (mín. 24 caracteres): acesso de emergência e criação da 1ª conta
node --env-file=.env --import tsx src/db/seed.ts      # opcional: dados DEMO marcados
node --env-file=.env --import tsx src/server/main.ts  # API + dashboard em http://127.0.0.1:3100
node --env-file=.env --import tsx src/scheduler/worker.ts  # Mega Brain contínuo (24h)
```

## Produção

```bash
cd wedeals
cp .env.production.example .env.production   # DOMAIN, PUBLIC_BASE_URL, ADMIN_TOKEN
docker compose --env-file .env.production up -d --build
```

Detalhes, backup e restauração em [docs/DEPLOY.md](wedeals/docs/DEPLOY.md).

## Testes

```bash
cd wedeals
npm test                 # unidade, integração, segurança e E2E (98 testes)
npm run test:unit
npm run test:integration
npm run test:security
npm run test:e2e         # servidor HTTP real, fluxo completo, sem publicação real
npm run test:browser:install   # uma vez: baixa o Chromium headless (~106 MB)
npm run test:browser     # dashboard no Chromium: login, papéis, publicação assistida, XSS, celular
npm run typecheck
```

## Travas de segurança operacional

- `PUBLISH_ENABLED=false` (padrão): Telegram entra em *dry-run*; nada é enviado.
- WhatsApp sempre em **publicação assistida** — o admin envia e confirma.
- Provedores não oficiais de WhatsApp não estão implementados (teste automatizado garante).
- Links aceitos apenas de domínios oficiais dos marketplaces (ou redes parceiras configuradas).
- Cliques contados de forma agregada por hora, sem IP nem dados pessoais.
