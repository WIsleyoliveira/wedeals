export const MARKETPLACES = ["mercadolivre", "shopee", "shein"] as const;
export type Marketplace = (typeof MARKETPLACES)[number];

export const MARKETPLACE_LABEL: Record<Marketplace, string> = {
  mercadolivre: "Mercado Livre",
  shopee: "Shopee",
  shein: "SHEIN",
};

/** Estados de uma oferta no pipeline do Mega Brain. */
export type OfferStatus =
  | "discovered" // encontrada, ainda não avaliada
  | "awaiting_link" // aprovada, aguardando link oficial de afiliado
  | "approved" // pronta para fila
  | "rejected"
  | "queued"
  | "published"
  | "expired";

export interface RawOffer {
  marketplace: Marketplace;
  externalId: string;
  title: string;
  url: string; // URL pública do produto
  imageUrl?: string | null; // imagem oficial do anúncio
  price: number; // preço atual em BRL
  originalPrice?: number | null; // "de" anunciado
  category: string;
  sellerName?: string | null;
  sellerReputation?: number | null; // 0..1
  officialStore?: boolean;
  inStock?: boolean;
  commissionRate?: number | null; // 0..1
  couponCode?: string | null;
  couponDiscount?: number | null; // em BRL
  affiliateUrl?: string | null;
}

export interface Offer extends RawOffer {
  id: number;
  status: OfferStatus;
  dealScore: number | null;
  rejectReason: string | null;
  scoreBreakdown: string | null;
  createdAt: string;
  updatedAt: string;
}

export type GroupPlatform = "whatsapp" | "telegram";
export type PublishMode = "assisted" | "automatic";
export type GroupStatus = "active" | "paused";

export interface Group {
  id: number;
  name: string;
  platform: GroupPlatform;
  inviteLink: string | null;
  externalId: string | null;
  admins: string[];
  categories: string[]; // vazio = todas
  marketplaces: Marketplace[]; // vazio = todos
  audience: number | null;
  audienceSource: "informed" | "official" | null;
  windowStart: string; // "08:00"
  windowEnd: string; // "22:00"
  minIntervalMinutes: number;
  maxDailyPosts: number;
  minDealScore: number;
  template: string | null;
  affiliateAccount: string | null;
  mode: PublishMode;
  status: GroupStatus;
  repostCooldownDays: number;
  createdAt: string;
}

export type PublicationStatus =
  | "scheduled"
  | "ready_for_admin" // assistido: conteúdo pronto aguardando o admin
  | "published"
  | "skipped"
  | "failed"
  | "dry_run";

export interface Publication {
  id: number;
  offerId: number;
  groupId: number;
  scheduledFor: string;
  status: PublicationStatus;
  message: string;
  trackingCode: string;
  imageUrl: string | null;
  publishedAt: string | null;
  error: string | null;
}

export type CommissionStatus = "pending" | "approved" | "paid" | "cancelled";

/** Papéis no dashboard. admin: tudo, inclusive usuários e configurações. operador: o dia a dia. */
export const ROLES = ["admin", "operador"] as const;
export type Role = (typeof ROLES)[number];

/** Conta de pessoa no dashboard. Só o necessário: sem e-mail, telefone ou documento. */
export interface User {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  /** Verificação em duas etapas (app autenticador) ativa. */
  mfaEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}
