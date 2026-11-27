import type { TextProvider } from "../ai/provider";
import { MARKETPLACE_LABEL, type Offer } from "../domain/types";

export const DEFAULT_TEMPLATE = `{chamada}

🛍️ *{titulo}*
{linha_preco}
{linha_cupom}🏪 {marketplace}

👉 {link}

_Preço e estoque podem mudar a qualquer momento._`;

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** Remove formatação que poderia quebrar a mensagem ou injetar marcação. */
export function sanitizeText(s: string, max = 140): string {
  return s
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const FALLBACK_HOOKS = ["🔥 Oferta selecionada", "⚡ Achado do dia", "💰 Preço baixo agora", "✅ Promoção verificada"];

/**
 * A IA só escreve a frase de chamada. Para evitar alucinação, a chamada é descartada se contiver
 * números, links, preços ou promessas — todos os fatos vêm dos dados verificados da oferta.
 */
export function acceptHook(text: string | null): string | null {
  if (!text) return null;
  const t = sanitizeText(text.split("\n")[0].replace(/^["']|["']$/g, ""), 80);
  if (t.length < 4) return null;
  if (/\d|https?:|www\.|r\$|grátis|garantid|frete/i.test(t)) return null;
  return t;
}

export interface MessageInput {
  offer: Offer;
  link: string;
  template?: string | null;
  hook?: string | null;
}

export function renderMessage({ offer, link, template, hook }: MessageInput): string {
  const discount =
    offer.originalPrice && offer.originalPrice > offer.price
      ? Math.round(((offer.originalPrice - offer.price) / offer.originalPrice) * 100)
      : 0;
  const linhaPreco =
    discount > 0
      ? `~${brl(offer.originalPrice!)}~ por *${brl(offer.price)}* (-${discount}%)`
      : `Por *${brl(offer.price)}*`;
  const linhaCupom = offer.couponCode ? `🎟️ Cupom: *${sanitizeText(offer.couponCode, 30)}*\n` : "";
  const vars: Record<string, string> = {
    chamada: hook ?? FALLBACK_HOOKS[offer.id % FALLBACK_HOOKS.length],
    titulo: sanitizeText(offer.title, 120),
    linha_preco: linhaPreco,
    linha_cupom: linhaCupom,
    preco: brl(offer.price),
    preco_de: offer.originalPrice ? brl(offer.originalPrice) : "",
    desconto: discount ? `${discount}%` : "",
    cupom: offer.couponCode ? sanitizeText(offer.couponCode, 30) : "",
    marketplace: MARKETPLACE_LABEL[offer.marketplace],
    link,
  };
  return (template || DEFAULT_TEMPLATE)
    .replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function generateHook(ai: TextProvider, offer: Offer): Promise<string | null> {
  const prompt =
    `Escreva UMA frase curta (até 8 palavras), animada, em português do Brasil, para anunciar este produto ` +
    `num grupo de promoções. Não use números, preços, links nem promessas. Produto: ${sanitizeText(offer.title, 100)}. ` +
    `Responda só com a frase.`;
  return acceptHook(await ai.complete(prompt));
}
