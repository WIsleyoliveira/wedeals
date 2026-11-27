import type { Fetcher } from "../marketplaces/adapter";

/**
 * Alertas operacionais para o administrador (não são publicações nos grupos).
 * Canais: Telegram (chat do admin) e/ou webhook HTTPS. Sem canal configurado, só registra no log.
 */
export interface AlertConfig {
  telegramBotToken: string;
  telegramChatId: string;
  webhookUrl: string;
  repeatHours: number; // reenvia um alerta ainda ativo depois deste intervalo
  instance: string; // identifica o servidor na mensagem
}

export function alertConfigFromEnv(env: NodeJS.ProcessEnv): AlertConfig {
  const webhookUrl = (env.ALERT_WEBHOOK_URL ?? "").trim();
  if (webhookUrl && new URL(webhookUrl).protocol !== "https:") throw new Error("ALERT_WEBHOOK_URL precisa usar https");
  return {
    telegramBotToken: (env.ALERT_TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN || "").trim(),
    telegramChatId: (env.ALERT_TELEGRAM_CHAT_ID ?? "").trim(),
    webhookUrl,
    repeatHours: Math.max(1, Number(env.ALERT_REPEAT_HOURS ?? 6) || 6),
    instance: (env.ALERT_INSTANCE_NAME || env.DOMAIN || "wedeals").trim(),
  };
}

export interface Notifier {
  readonly channels: string[];
  send(text: string): Promise<void>;
}

/** Remove segredos conhecidos e padrões de token de qualquer texto antes de enviar. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("***");
  return out
    .replace(/bot\d{5,}:[\w-]{20,}/g, "bot***")
    .replace(/(Bearer\s+)[\w.~+/=-]{12,}/gi, "$1***")
    .replace(/((?:^|[\s?&])(?:token|access_token|key|secret|signature|sig)=)[^&\s]+/gi, "$1***");
}

export function buildNotifier(cfg: AlertConfig, secrets: string[], fetcher: Fetcher = fetch): Notifier {
  const targets: { name: string; send: (text: string) => Promise<void> }[] = [];
  if (cfg.telegramBotToken && cfg.telegramChatId) {
    targets.push({
      name: "telegram",
      send: async (text) => {
        const res = await fetcher(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: cfg.telegramChatId, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
      },
    });
  }
  if (cfg.webhookUrl) {
    targets.push({
      name: "webhook",
      send: async (text) => {
        // "text" (Slack, Google Chat, ntfy etc.) e "content" (Discord) com o mesmo conteúdo
        const res = await fetcher(cfg.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, content: text.slice(0, 2000) }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
      },
    });
  }
  const allSecrets = [...secrets, cfg.telegramBotToken];
  return {
    channels: targets.map((t) => t.name),
    async send(text) {
      const clean = redact(text, allSecrets).slice(0, 3500);
      const errors: string[] = [];
      await Promise.all(targets.map((t) => t.send(clean).catch((e) => errors.push(`${t.name}: ${redact((e as Error).message, allSecrets)}`))));
      if (errors.length) throw new Error(`falha ao enviar alerta (${errors.join("; ")})`);
    },
  };
}

export interface AlertState {
  [key: string]: { since: string; lastSentAt: string | null; message: string };
}

export interface AlertStore {
  load(): AlertState;
  save(s: AlertState): void;
}

export const memoryStore = (): AlertStore => {
  let s: AlertState = {};
  return { load: () => s, save: (n) => void (s = n) };
};

export interface Issue {
  key: string; // estável: identifica o problema (ex.: "agente:distribuicao:parado")
  message: string;
}

export interface AlertEvent {
  type: "novo" | "continua" | "resolvido";
  key: string;
  message: string;
}

export interface AlertResult {
  sent: string[];
  resolved: string[];
  active: string[];
  /** O que mudou nesta verificação (para o histórico do dashboard). */
  events: AlertEvent[];
  sendError?: string;
}

/**
 * Compara os problemas atuais com os já conhecidos: alerta os novos, repete os que continuam depois de
 * `repeatHours` e avisa quando um problema some. Sem canal configurado, nada é enviado.
 */
export class AlertManager {
  constructor(
    private notifier: Notifier,
    private store: AlertStore,
    private cfg: Pick<AlertConfig, "repeatHours" | "instance">,
    private log: (line: string) => void = console.log,
  ) {}

  get enabled() {
    return this.notifier.channels.length > 0;
  }

  async update(issues: Issue[], now: Date): Promise<AlertResult> {
    const prev = this.store.load();
    const next: AlertState = {};
    const toSend: string[] = [];
    const events: AlertEvent[] = [];
    const sent: string[] = [];
    const resolved: string[] = [];
    const repeatMs = this.cfg.repeatHours * 3_600_000;

    for (const i of issues) {
      const p = prev[i.key];
      const due = !p || !p.lastSentAt || now.getTime() - new Date(p.lastSentAt).getTime() >= repeatMs;
      next[i.key] = { since: p?.since ?? now.toISOString(), lastSentAt: p?.lastSentAt ?? null, message: i.message };
      if (due) {
        toSend.push(`${p ? "⚠️ Continua" : "🚨"} ${i.message}${p ? ` (desde ${fmt(p.since)})` : ""}`);
        events.push({ type: p ? "continua" : "novo", key: i.key, message: i.message });
        sent.push(i.key);
      }
    }
    for (const [key, p] of Object.entries(prev)) {
      if (next[key]) continue;
      resolved.push(key);
      events.push({ type: "resolvido", key, message: p.message });
      if (p.lastSentAt) toSend.push(`✅ Resolvido: ${p.message}`);
    }

    const result: AlertResult = { sent: [], resolved, active: Object.keys(next), events };
    if (toSend.length) {
      const text = `WeDeals · ${this.cfg.instance}\n\n${toSend.join("\n")}`;
      this.log(`[alerta] ${toSend.join(" | ")}`);
      if (!this.enabled) {
        // sem canal: o log já é o aviso; marca para não repetir a cada verificação
        for (const k of sent) next[k].lastSentAt = now.toISOString();
      } else {
        try {
          await this.notifier.send(text);
          for (const k of sent) next[k].lastSentAt = now.toISOString();
          result.sent = sent;
        } catch (e) {
          result.sendError = (e as Error).message;
          this.log(`[alerta] ${result.sendError}`);
          // não marca como enviado: tenta de novo na próxima verificação; resolvidos são descartados
        }
      }
    }
    this.store.save(next);
    return result;
  }
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
