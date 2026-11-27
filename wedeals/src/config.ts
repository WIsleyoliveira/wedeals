export interface AppConfig {
  port: number;
  adminToken: string;
  databasePath: string;
  publishEnabled: boolean;
  publicBaseUrl: string;
  shopee: { appId: string; appSecret: string; apiUrl: string };
  mlAccessToken: string;
  affiliateExtraDomains: string[];
  telegramBotToken: string;
  ai: { provider: "none" | "ollama"; ollamaUrl: string; ollamaModel: string; dailyBudgetCalls: number };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3100),
    adminToken: env.ADMIN_TOKEN ?? "",
    databasePath: env.DATABASE_PATH ?? "./data/wedeals.db",
    // Publicação real só com liberação explícita.
    publishEnabled: env.PUBLISH_ENABLED === "true",
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? "http://localhost:3100").replace(/\/$/, ""),
    shopee: {
      appId: env.SHOPEE_APP_ID ?? "",
      appSecret: env.SHOPEE_APP_SECRET ?? "",
      apiUrl: env.SHOPEE_API_URL ?? "https://open-api.affiliate.shopee.com.br/graphql",
    },
    mlAccessToken: env.ML_ACCESS_TOKEN ?? "",
    affiliateExtraDomains: (env.AFFILIATE_EXTRA_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    telegramBotToken: env.TELEGRAM_BOT_TOKEN ?? "",
    ai: {
      provider: env.AI_PROVIDER === "ollama" ? "ollama" : "none",
      ollamaUrl: env.OLLAMA_URL ?? "http://127.0.0.1:11434",
      ollamaModel: env.OLLAMA_MODEL ?? "llama3.1:8b",
      dailyBudgetCalls: Number(env.AI_DAILY_BUDGET_CALLS ?? 500),
    },
  };
}
