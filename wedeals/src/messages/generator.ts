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

/** Modelos prontos (usados sem IA, com a IA fora do ar ou quando ela não passa na checagem). */
export const FALLBACK_HOOKS = [
  "🔥 Oferta selecionada",
  "⚡ Achado do dia",
  "💰 Preço baixo agora",
  "✅ Promoção verificada",
  "👀 Olha só o que apareceu",
  "🛒 Vale a pena conferir",
  "✨ Boa oportunidade",
  "📣 Oferta nova no grupo",
  "🎯 Escolhido pra você",
  "💡 Dica de compra",
];

/**
 * A IA só escreve a frase de chamada. Para evitar alucinação, a chamada é descartada se contiver
 * números, links, preços, promessas ou urgência inventada — todos os fatos vêm dos dados verificados da oferta.
 */
const FORBIDDEN = new RegExp(
  [
    /\d|https?:|www\./.source, // números e links
    /r\$|reais|preç|barat|caro\b|econom|desconto|cupom|promoç|oferta|frete|grátis|gratuit/.source, // preço e condições: vêm dos dados
    /garantid|melhor|qualidade|premium|original\b|perfeit|incrível|imperdível|top\b|número um/.source, // qualidade não verificável
    /\bmais \w+ (?:da|do|de)\b|\bo mais\b|\ba mais\b/.source, // superlativos ("o mais vendido", "mais confortável da moda")
    /únic|exclusiv|últim[oa]s?|acaba|só hoje|corre\b|esgot|relâmpago|black friday|agora ou nunca/.source, // urgência inventada
    /vende-se|à venda|compre\b|adquira/.source, // tom de classificado
  ].join("|"),
  "i",
);

/** Emojis que combinam com chamadas de oferta; os demais saem da frase (o modelo às vezes escolhe 🗑️ ou 🗿). */
const ALLOWED_EMOJI = new Set(
  [..."🔥⚡✨🎯💡🛒👀📣✅🎧🔊📱⌚💻🎮📷🍳🍟☕🍽🏠🛋🧹🧺🧼🧴💄💅👗👕👖👟👠👜🎒🧸🎁😊😍🤩👍🙌💪🌿🌞❄🏃🧘🚗🐶🐱📚✏🛠🧰"].filter((c) => /\p{Extended_Pictographic}/u.test(c)),
);
const stripOddEmoji = (s: string) =>
  s
    .replace(/(\p{Extended_Pictographic})\uFE0F?/gu, (m, e: string) => (ALLOWED_EMOJI.has(e) ? m : ""))
    .replace(/\s+/g, " ")
    .trim();

export function acceptHook(text: string | null): string | null {
  if (!text) return null;
  const t = stripOddEmoji(sanitizeText(
    text
      .split("\n")[0]
      .replace(/^\s*(?:[-•*]|\d+[.)]|chamada\s*\d*:?)\s*/i, "") // "1.", "- ", "Chamada:"
      .replace(/^["'“”]+|["'“”]+$/g, ""),
    80,
  ));
  if (t.length < 4 || t.split(/\s+/).length > 12) return null;
  if (FORBIDDEN.test(t)) return null;
  if (/[a-z]{3,}/i.test(t) && /\b(the|and|deal|offer|now|best)\b/i.test(t)) return null; // resposta em inglês
  return t;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

/** Parecidas demais: mesmas palavras em ≥ 60% (ignora emojis, acentos e palavras curtas). */
export function similarHooks(a: string, b: string): boolean {
  const A = new Set(norm(a));
  const B = new Set(norm(b));
  if (!A.size || !B.size) return a.trim() === b.trim();
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / new Set([...A, ...B]).size >= 0.6;
}

/** Primeira chamada da lista que não se parece com nenhuma das recentes. */
export function pickHook(candidates: string[], recent: string[]): string | null {
  return candidates.find((c) => !recent.some((r) => similarHooks(c, r))) ?? null;
}

/** Modelo pronto que não foi usado recentemente no grupo (ou o menos recente, se todos foram). */
export function fallbackHook(offer: Offer, recent: string[]): string {
  const start = offer.id % FALLBACK_HOOKS.length;
  const order = [...FALLBACK_HOOKS.slice(start), ...FALLBACK_HOOKS.slice(0, start)];
  return order.find((h) => !recent.includes(h)) ?? order.reduce((best, h) => (recent.indexOf(h) > recent.indexOf(best) ? h : best));
}

const SYSTEM_PROMPT = `Você escreve a frase de abertura de mensagens num grupo de promoções do WhatsApp, em português do Brasil.
A mensagem abaixo da sua frase já traz nome, preço e link. Sua frase só desperta interesse pelo uso do produto.
Regras obrigatórias:
- Até 8 palavras, tom leve e natural, falando com "você". Pode começar com 1 emoji.
- Fale do uso ou do benefício prático, sem inventar características que não estão no nome do produto.
- NUNCA fale de preço, desconto, oferta, promoção, cupom ou frete, e NUNCA use números ou links.
- NUNCA diga que é o melhor, de qualidade, perfeito, incrível ou "o mais" alguma coisa.
- NUNCA invente urgência ou exclusividade ("só hoje", "últimas unidades", "exclusivo").
- Não escreva como anúncio de classificado ("vende-se", "compre").
Exemplos do tom certo: "🎧 Seu som sem barulho em volta" · "🍳 Cozinhar ficou mais simples" · "👗 Estampa leve pros dias quentes".
Responda apenas com as frases pedidas, uma por linha, sem numeração e sem aspas.`;

/**
 * Pede 3 chamadas diferentes para a oferta numa só chamada ao modelo (uma por grupo, sem repetir).
 * Devolve só as que passam na checagem de fatos, ou null se a IA não respondeu (fora do ar / tempo esgotado).
 */
export async function generateHooks(ai: TextProvider, offer: Offer, avoid: string[] = []): Promise<string[] | null> {
  const avoidList = avoid.slice(0, 10).map((h) => `- ${sanitizeText(h, 80)}`).join("\n");
  const user =
    `Produto: ${sanitizeText(offer.title, 100)}\nCategoria: ${sanitizeText(offer.category, 40)}\nLoja: ${MARKETPLACE_LABEL[offer.marketplace]}\n` +
    (avoidList ? `Frases já usadas recentemente (escreva diferentes destas):\n${avoidList}\n` : "") +
    `Escreva 3 frases de abertura diferentes entre si.`;
  const out = await ai.complete({ system: SYSTEM_PROMPT, user, temperature: 0.9, maxTokens: 120 });
  if (!out) return null;
  const accepted: string[] = [];
  for (const line of out.split("\n")) {
    const h = acceptHook(line);
    if (h && !accepted.some((x) => similarHooks(x, h))) accepted.push(h);
  }
  return accepted;
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
