# WeDeals — imagem única para servidor, worker (Mega Brain) e backup.
FROM node:22.19.0-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Só dependências de produção (fastify, zod, tsx). Playwright, vitest e TypeScript ficam de fora.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src

# Banco e backups em volumes; o processo roda sem root.
RUN mkdir -p /app/data /app/backups && chown node:node /app/data /app/backups
USER node

ENV HOST=0.0.0.0 \
    PORT=3100 \
    DATABASE_PATH=/app/data/wedeals.db \
    BACKUP_DIR=/app/backups

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings", "--import", "tsx", "src/server/main.ts"]
