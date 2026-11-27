# Deploy com Docker

Uma imagem roda quatro serviços (`compose.yaml`):

| Serviço | O que faz |
|---|---|
| `app` | API, dashboard e redirecionador de links rastreados (`/r/...`) |
| `worker` | Mega Brain 24h: pesquisa, classificação, fila, distribuição e aprendizado |
| `backup` | Cópia do banco a cada 6h, mantendo as últimas 28 (7 dias) |
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

As cópias ficam no volume `backups`, **no mesmo servidor**. Para proteger contra perda do servidor,
copie-as para fora regularmente:

```bash
docker compose cp backup:/app/backups ./backups-$(date +%F)
```

Restaurar uma cópia (substitui o banco atual):

```bash
docker compose stop app worker backup
docker compose cp ./backups-AAAA-MM-DD/wedeals-AAAAMMDDTHHMMSSZ.db backup:/app/data/wedeals.db
docker compose run --rm --no-deps backup sh -c 'rm -f /app/data/wedeals.db-wal /app/data/wedeals.db-shm'
docker compose --env-file .env.production up -d
```

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
4. Uma cópia de backup feita e baixada para fora do servidor.
