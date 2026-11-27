import type { AppConfig } from "../config";
import type { Fetcher } from "../marketplaces/adapter";

/**
 * Provedor de texto opcional e gratuito (Ollama local, sem envio de dados para terceiros).
 * Sem provedor, ou com ele fora do ar, o sistema usa os modelos prontos de chamada.
 */
export interface TextProvider {
  readonly name: string;
  readonly model?: string;
  /** Texto gerado, ou null se o provedor não respondeu a tempo / está fora do ar. */
  complete(prompt: CompletionRequest): Promise<string | null>;
  /** Último erro, para o painel e os alertas. */
  readonly lastError?: string | null;
}

export interface CompletionRequest {
  system: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}

export class NoAI implements TextProvider {
  readonly name = "none";
  async complete() {
    return null;
  }
}

export class OllamaProvider implements TextProvider {
  readonly name = "ollama";
  lastError: string | null = null;
  constructor(
    private url: string,
    readonly model: string,
    private fetcher: Fetcher = fetch,
    private timeoutMs = 45_000,
  ) {}

  async complete(r: CompletionRequest): Promise<string | null> {
    try {
      const res = await this.fetcher(`${this.url.replace(/\/+$/, "")}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          keep_alive: "30m", // mantém o modelo carregado entre ciclos da fila
          messages: [
            { role: "system", content: r.system },
            { role: "user", content: r.user },
          ],
          options: { temperature: r.temperature ?? 0.9, num_predict: r.maxTokens ?? 120 },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        this.lastError = `Ollama HTTP ${res.status}${/not found/i.test(body) ? ` (modelo ${this.model} não instalado: rode "ollama pull ${this.model}")` : ""}`;
        return null;
      }
      const j = (await res.json()) as { message?: { content?: string } };
      this.lastError = null;
      return j.message?.content?.trim() ?? null;
    } catch (e) {
      const msg = (e as Error).name === "TimeoutError" ? "tempo esgotado" : (e as Error).message;
      this.lastError = `Ollama indisponível: ${msg}`;
      return null;
    }
  }
}

export function buildTextProvider(cfg: AppConfig, fetcher: Fetcher = fetch): TextProvider {
  return cfg.ai.provider === "ollama" ? new OllamaProvider(cfg.ai.ollamaUrl, cfg.ai.ollamaModel, fetcher, cfg.ai.timeoutMs) : new NoAI();
}
