import type { AppConfig } from "../config";
import type { Fetcher } from "../marketplaces/adapter";

/** Provedor de texto opcional e gratuito (Ollama local). Sem provedor, o sistema usa só templates. */
export interface TextProvider {
  readonly name: string;
  complete(prompt: string): Promise<string | null>;
}

export class NoAI implements TextProvider {
  readonly name = "none";
  async complete() {
    return null;
  }
}

export class OllamaProvider implements TextProvider {
  readonly name = "ollama";
  constructor(
    private url: string,
    private model: string,
    private fetcher: Fetcher = fetch,
  ) {}
  async complete(prompt: string): Promise<string | null> {
    try {
      const res = await this.fetcher(`${this.url}/api/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt, stream: false, options: { temperature: 0.7, num_predict: 60 } }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { response?: string };
      return j.response?.trim() ?? null;
    } catch {
      return null;
    }
  }
}

export function buildTextProvider(cfg: AppConfig, fetcher: Fetcher = fetch): TextProvider {
  return cfg.ai.provider === "ollama" ? new OllamaProvider(cfg.ai.ollamaUrl, cfg.ai.ollamaModel, fetcher) : new NoAI();
}
