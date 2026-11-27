import type { Group, Offer, Publication, PublicationStatus } from "../domain/types";
import type { Fetcher } from "../marketplaces/adapter";

export interface DeliveryResult {
  status: PublicationStatus;
  error?: string;
}

/**
 * Canal de distribuição desacoplado. Novas integrações OFICIAIS (ex.: futura API de grupos/canais do
 * WhatsApp) entram implementando esta interface. Provedores não oficiais NÃO estão implementados e só
 * podem ser adicionados com aprovação expressa da WAPE.
 */
export interface DistributionChannel {
  readonly id: string;
  readonly official: boolean;
  readonly automatic: boolean;
  supports(group: Group): boolean;
  deliver(pub: Publication, group: Group, offer: Offer): Promise<DeliveryResult>;
}

/** WhatsApp: prepara o conteúdo para o administrador publicar (publicação assistida). */
export class AssistedWhatsAppChannel implements DistributionChannel {
  readonly id = "whatsapp_assisted";
  readonly official = true; // o envio é feito pelo próprio admin no app oficial
  readonly automatic = false;
  supports(g: Group) {
    return g.platform === "whatsapp" || g.mode === "assisted";
  }
  async deliver(): Promise<DeliveryResult> {
    return { status: "ready_for_admin" };
  }
}

/** Telegram Bot API (oficial). Só envia de verdade com PUBLISH_ENABLED=true e token configurado. */
export class TelegramChannel implements DistributionChannel {
  readonly id = "telegram_bot";
  readonly official = true;
  readonly automatic = true;
  constructor(
    private token: string,
    private publishEnabled: boolean,
    private fetcher: Fetcher = fetch,
  ) {}
  supports(g: Group) {
    return g.platform === "telegram" && g.mode === "automatic" && Boolean(g.externalId);
  }
  async deliver(pub: Publication, group: Group): Promise<DeliveryResult> {
    if (!this.publishEnabled) return { status: "dry_run" };
    if (!this.token) return { status: "failed", error: "TELEGRAM_BOT_TOKEN ausente" };
    const method = pub.imageUrl ? "sendPhoto" : "sendMessage";
    const body = pub.imageUrl
      ? { chat_id: group.externalId, photo: pub.imageUrl, caption: pub.message.slice(0, 1024) }
      : { chat_id: group.externalId, text: pub.message, disable_web_page_preview: false };
    try {
      const res = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const j = (await res.json()) as { ok: boolean; description?: string };
      return j.ok ? { status: "published" } : { status: "failed", error: j.description ?? `HTTP ${res.status}` };
    } catch (e) {
      return { status: "failed", error: (e as Error).message };
    }
  }
}

export class ChannelRouter {
  constructor(private channels: DistributionChannel[]) {}
  /** Escolhe o canal: automático oficial quando suportado; senão, assistido. */
  pick(group: Group): DistributionChannel {
    const auto = this.channels.find((c) => c.automatic && c.supports(group));
    if (auto && group.mode === "automatic") return auto;
    return this.channels.find((c) => !c.automatic)!;
  }
  list() {
    return this.channels.map((c) => ({ id: c.id, official: c.official, automatic: c.automatic }));
  }
}
