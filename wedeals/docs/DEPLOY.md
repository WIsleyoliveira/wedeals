# Deploy com Docker

Uma imagem roda quatro serviços (`compose.yaml`):

| Serviço | O que faz |
|---|---|
| `app` | API, dashboard, redirecionador de links rastreados (`/r/...`) e monitor de falhas |
| `worker` | Mega Brain 24h: pesquisa, classificação, fila, distribuição e aprendizado |
| `backup` | Cópia do banco a cada 6h (últimas 28 no servidor) e envio para armazenamento externo |
| `caddy` | HTTPS automático (Let's Encrypt) e redirecionamento de HTTP para HTTPS |

O banco SQLite fica no volume `data`, compartilhado por `app`, `worker` e `backup`. Só o Caddy expõe
portas (80 e 443); o app não fica acessível diretamente.

## Requisitos

- Servidor Linux com Docker e o plugin Compose. Para o volume atual, 1 vCPU e 1 GB de RAM bastam.
- Um domínio (ou subdomínio) com registro DNS A/AAAA apontando para o IP do servidor.
- Portas 80 e 443 liberadas no firewall (a 80 é usada para emitir o certificado).

## Primeira instalação

```bash
git clone https://github.com/WIsleyoliveira/wedeals.git
cd wedeals/wedeals
cp .env.production.example .env.production
```

Edite `.env.production`:

- `DOMAIN` e `PUBLIC_BASE_URL` com o domínio real (o segundo com `https://`).
- `ADMIN_TOKEN` com um valor gerado por `openssl rand -base64 36`.
- Deixe `PUBLISH_ENABLED=false` até a WAPE autorizar publicações reais.

```bash
docker compose --env-file .env.production up -d --build
docker compose ps
```

Abra `https://SEU_DOMINIO` e entre com o `ADMIN_TOKEN`. O `.env.production` fica fora do git.

## Operação

```bash
docker compose logs -f app worker          # acompanhar
docker compose restart worker               # reiniciar um serviço
```

**Atualizar** para a versão mais recente da `main`:

```bash
git pull
docker compose --env-file .env.production up -d --build
```

Os serviços reiniciam sozinhos se caírem ou se o servidor reiniciar (`restart: unless-stopped`).
`docker compose stop` encerra tudo de forma limpa: as requisições terminam e o banco é fechado.

## Backup e restauração

A cada 6h o serviço `backup` faz uma cópia consistente do banco no volume `backups` (mantém 28 = 7 dias)
e, se configurado, envia a cópia comprimida (`.db.gz`) para um armazenamento externo compatível com S3.
Se a cópia ou o envio falhar, chega um alerta (ver abaixo); a cópia local é mantida mesmo quando o envio falha.

### Armazenamento externo

Funciona com Cloudflare R2, Backblaze B2 e AWS S3 (o banco tem poucos MB, então o custo fica perto de zero).

1. Crie um bucket **privado** só para o WeDeals.
2. Crie uma chave de acesso com permissão **só de escrita** nesse bucket: se o servidor for comprometido,
   a chave não serve para ler nem apagar as cópias.
3. Configure uma **regra de ciclo de vida** no bucket para apagar objetos com mais de 30 dias
   (o WeDeals não apaga nada lá).
4. Preencha as variáveis `BACKUP_S3_*` do `.env.production` e reinicie o backup:

```bash
docker compose --env-file .env.production up -d backup
docker compose logs backup      # deve mostrar "backup enviado: <bucket>/wedeals/..."
```

### Restaurar

Baixe a cópia do bucket (ou use uma do volume `backups`) e descomprima com `gunzip`. Depois:

```bash
docker compose stop app worker backup
docker compose cp ./wedeals-AAAAMMDDTHHMMSSZ.db backup:/app/data/wedeals.db
docker compose run --rm --no-deps backup sh -c 'rm -f /app/data/wedeals.db-wal /app/data/wedeals.db-shm'
docker compose --env-file .env.production up -d
```

Para copiar as cópias locais para fora do servidor manualmente:

```bash
docker compose cp backup:/app/backups ./backups-$(date +%F)
```

## Alertas de falha

O app verifica a cada 5 minutos o que o worker registra e avisa o administrador quando:

| Situação | Quando |
|---|---|
| Worker do Mega Brain parado | nenhum agente rodou no tempo esperado |
| Agente atrasado | distribuição > 10 min, classificação > 15 min, fila > 30 min, pesquisa > 60 min, aprendizado > 13 h |
| Agente com erro | a última execução falhou (ex.: credencial da Shopee recusada) |
| Publicações automáticas falhando | alguma falhou na última hora |
| Backup ou envio externo falhou | avisado pelo próprio serviço de backup |

Cada problema é avisado uma vez, repetido a cada `ALERT_REPEAT_HOURS` (6h) enquanto continuar, e gera um
"✅ Resolvido" quando some. O app também avisa quando é iniciado: vários avisos seguidos indicam que ele
está caindo e reiniciando. Tokens e senhas são removidos das mensagens antes do envio.

Os alertas vão para o administrador, não para os grupos de ofertas, e não dependem de `PUBLISH_ENABLED`.

**Telegram:** crie um bot com o @BotFather (ou use o mesmo do canal de ofertas), mande uma mensagem
para ele e descubra o ID do chat em `https://api.telegram.org/bot<TOKEN>/getUpdates` (campo `chat.id`).
Preencha `ALERT_TELEGRAM_CHAT_ID` (e `ALERT_TELEGRAM_BOT_TOKEN`, se for outro bot).

**Webhook:** `ALERT_WEBHOOK_URL` com uma URL HTTPS (Discord, Slack, Google Chat, ntfy…). O corpo é
`{"text": "...", "content": "..."}`.

Depois de configurar, reinicie e mande um alerta de teste:

```bash
docker compose --env-file .env.production up -d
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" https://SEU_DOMINIO/api/alerts/test
```

### Monitor externo (recomendado)

Se o servidor inteiro cair, ele não consegue avisar. Cadastre `https://SEU_DOMINIO/api/health` num
monitor externo gratuito (UptimeRobot, Better Stack, Healthchecks.io) com verificação a cada 5 minutos.

## Segurança

- O dashboard fica público na internet, protegido pelo `ADMIN_TOKEN`. Tentativas erradas são
  bloqueadas por IP após 10 falhas em 15 minutos. O app confia só no Caddy (`TRUST_PROXY_HOPS=1`)
  para saber o IP real do visitante.
- Para restringir o painel a IPs conhecidos, adicione ao `Caddyfile`, antes do `reverse_proxy`
  (o `/r/*` e o `/api/health` continuam públicos):

  ```
  @painel {
  	not path /r/* /api/health
  	not remote_ip 203.0.113.10
  }
  respond @painel 403
  ```

- Os containers do app rodam sem root. A imagem não inclui ferramentas de teste.

## Antes de ligar `PUBLISH_ENABLED=true`

1. Autorização expressa da WAPE.
2. Grupos reais cadastrados, com janelas, limites e links de convite corretos.
3. `PUBLIC_BASE_URL` com o domínio real (os links rastreados nas mensagens dependem dele).
4. Backup externo configurado e uma restauração testada.
5. Alertas configurados e o alerta de teste recebido.
