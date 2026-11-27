import type { BrainContext } from "../src/brain/pipeline";
import { loadConfig, type AppConfig } from "../src/config";
import { buildContext, type ContextOverrides } from "../src/context";
import type { Group, Offer } from "../src/domain/types";
import type { GroupInput } from "../src/db/repo";

export const TOKEN = "test-admin-token-0123456789abcdef";
export const T0 = new Date("2026-11-27T15:00:00.000Z"); // 12:00 em Brasília

export function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({}), adminToken: TOKEN, databasePath: ":memory:", publicBaseUrl: "https://wedeals.test", ...over };
}

export function makeCtx(over: ContextOverrides & { cfg?: Partial<AppConfig> } = {}) {
  let now = over.clock?.() ?? T0;
  const ctx: BrainContext = buildContext(testConfig(over.cfg), { ...over, clock: () => now });
  return {
    ctx,
    setNow: (d: Date) => (now = d),
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
  };
}

export function groupInput(over: Partial<GroupInput> = {}): GroupInput {
  return {
    name: "Grupo teste",
    platform: "whatsapp",
    inviteLink: "https://chat.whatsapp.com/TESTE",
    externalId: null,
    admins: [],
    categories: [],
    marketplaces: [],
    audience: null,
    audienceSource: null,
    windowStart: "08:00",
    windowEnd: "22:00",
    minIntervalMinutes: 30,
    maxDailyPosts: 3,
    minDealScore: 50,
    template: null,
    affiliateAccount: null,
    mode: "assisted",
    status: "active",
    repostCooldownDays: 7,
    ...over,
  };
}

export function group(over: Partial<Group> = {}): Group {
  return { id: 1, createdAt: T0.toISOString(), ...groupInput(), ...over };
}

export function offer(over: Partial<Offer> = {}): Offer {
  return {
    id: 1,
    marketplace: "shopee",
    externalId: "X1",
    title: "Produto teste",
    url: "https://shopee.com.br/p-i.1.1",
    imageUrl: null,
    price: 100,
    originalPrice: 150,
    category: "casa",
    sellerName: null,
    sellerReputation: 0.9,
    officialStore: false,
    inStock: true,
    commissionRate: 0.1,
    couponCode: null,
    couponDiscount: null,
    affiliateUrl: "https://s.shopee.com.br/abc",
    status: "approved",
    dealScore: 70,
    rejectReason: null,
    scoreBreakdown: null,
    createdAt: T0.toISOString(),
    updatedAt: T0.toISOString(),
    ...over,
  };
}
