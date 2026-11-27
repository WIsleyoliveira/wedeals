import type { DB } from "./database";
import type {
  CommissionStatus,
  Group,
  Marketplace,
  Offer,
  OfferStatus,
  Publication,
  PublicationStatus,
  RawOffer,
  Role,
  User,
} from "../domain/types";

type Row = Record<string, any>;

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

function toOffer(r: Row): Offer {
  return {
    id: r.id,
    marketplace: r.marketplace,
    externalId: r.external_id,
    title: r.title,
    url: r.url,
    imageUrl: r.image_url,
    price: r.price,
    originalPrice: r.original_price,
    category: r.category,
    sellerName: r.seller_name,
    sellerReputation: r.seller_reputation,
    officialStore: !!r.official_store,
    inStock: !!r.in_stock,
    commissionRate: r.commission_rate,
    couponCode: r.coupon_code,
    couponDiscount: r.coupon_discount,
    affiliateUrl: r.affiliate_url,
    status: r.status,
    dealScore: r.deal_score,
    rejectReason: r.reject_reason,
    scoreBreakdown: r.score_breakdown,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toGroup(r: Row): Group {
  return {
    id: r.id,
    name: r.name,
    platform: r.platform,
    inviteLink: r.invite_link,
    externalId: r.external_id,
    admins: parse(r.admins, []),
    categories: parse(r.categories, []),
    marketplaces: parse(r.marketplaces, []),
    audience: r.audience,
    audienceSource: r.audience_source,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    minIntervalMinutes: r.min_interval_minutes,
    maxDailyPosts: r.max_daily_posts,
    minDealScore: r.min_deal_score,
    template: r.template,
    affiliateAccount: r.affiliate_account,
    mode: r.mode,
    status: r.status,
    repostCooldownDays: r.repost_cooldown_days,
    createdAt: r.created_at,
  };
}

function toPublication(r: Row): Publication {
  return {
    id: r.id,
    offerId: r.offer_id,
    groupId: r.group_id,
    scheduledFor: r.scheduled_for,
    status: r.status,
    message: r.message,
    trackingCode: r.tracking_code,
    imageUrl: r.image_url,
    publishedAt: r.published_at,
    error: r.error,
    hook: r.hook ?? null,
    hookSource: r.hook_source ?? null,
  };
}

export type GroupInput = Omit<Group, "id" | "createdAt">;

export class Repo {
  constructor(readonly db: DB) {}

  // ---------- Ofertas ----------
  upsertOffer(raw: RawOffer, now: Date, isDemo = false): Offer {
    const ts = now.toISOString();
    const existing = this.db
      .prepare("SELECT * FROM offers WHERE marketplace = ? AND external_id = ?")
      .get(raw.marketplace, raw.externalId) as Row | undefined;
    if (existing) {
      this.db
        .prepare(
          `UPDATE offers SET title=?, url=?, image_url=?, price=?, original_price=?, category=?, seller_name=?,
           seller_reputation=?, official_store=?, in_stock=?, commission_rate=?, coupon_code=?, coupon_discount=?,
           affiliate_url=COALESCE(?, affiliate_url), updated_at=? WHERE id=?`,
        )
        .run(
          raw.title,
          raw.url,
          raw.imageUrl ?? null,
          raw.price,
          raw.originalPrice ?? null,
          raw.category,
          raw.sellerName ?? null,
          raw.sellerReputation ?? null,
          raw.officialStore ? 1 : 0,
          raw.inStock === false ? 0 : 1,
          raw.commissionRate ?? null,
          raw.couponCode ?? null,
          raw.couponDiscount ?? null,
          raw.affiliateUrl ?? null,
          ts,
          existing.id,
        );
      // Produto já conhecido que mudou de preço volta a ser avaliado.
      if (["rejected", "expired", "published"].includes(existing.status) && existing.price !== raw.price) {
        this.db.prepare("UPDATE offers SET status='discovered' WHERE id=?").run(existing.id);
      }
    } else {
      this.db
        .prepare(
          `INSERT INTO offers (marketplace, external_id, title, url, image_url, price, original_price, category,
           seller_name, seller_reputation, official_store, in_stock, commission_rate, coupon_code, coupon_discount,
           affiliate_url, status, is_demo, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'discovered', ?, ?, ?)`,
        )
        .run(
          raw.marketplace,
          raw.externalId,
          raw.title,
          raw.url,
          raw.imageUrl ?? null,
          raw.price,
          raw.originalPrice ?? null,
          raw.category,
          raw.sellerName ?? null,
          raw.sellerReputation ?? null,
          raw.officialStore ? 1 : 0,
          raw.inStock === false ? 0 : 1,
          raw.commissionRate ?? null,
          raw.couponCode ?? null,
          raw.couponDiscount ?? null,
          raw.affiliateUrl ?? null,
          isDemo ? 1 : 0,
          ts,
          ts,
        );
    }
    this.addPricePoint(raw.marketplace, raw.externalId, raw.price, now);
    return this.getOfferByExternal(raw.marketplace, raw.externalId)!;
  }

  getOffer(id: number): Offer | undefined {
    const r = this.db.prepare("SELECT * FROM offers WHERE id = ?").get(id) as Row | undefined;
    return r ? toOffer(r) : undefined;
  }

  getOfferByExternal(m: Marketplace, externalId: string): Offer | undefined {
    const r = this.db
      .prepare("SELECT * FROM offers WHERE marketplace = ? AND external_id = ?")
      .get(m, externalId) as Row | undefined;
    return r ? toOffer(r) : undefined;
  }

  listOffers(filter: { status?: OfferStatus; marketplace?: Marketplace; limit?: number } = {}): Offer[] {
    const where: string[] = [];
    const args: any[] = [];
    if (filter.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    if (filter.marketplace) {
      where.push("marketplace = ?");
      args.push(filter.marketplace);
    }
    const sql = `SELECT * FROM offers ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY COALESCE(deal_score, 0) DESC, updated_at DESC LIMIT ?`;
    args.push(Math.min(filter.limit ?? 100, 500));
    return (this.db.prepare(sql).all(...args) as Row[]).map(toOffer);
  }

  updateOfferEvaluation(
    id: number,
    patch: { status: OfferStatus; dealScore?: number | null; rejectReason?: string | null; breakdown?: unknown },
    now: Date,
  ) {
    this.db
      .prepare(
        "UPDATE offers SET status=?, deal_score=COALESCE(?, deal_score), reject_reason=?, score_breakdown=COALESCE(?, score_breakdown), updated_at=? WHERE id=?",
      )
      .run(
        patch.status,
        patch.dealScore ?? null,
        patch.rejectReason ?? null,
        patch.breakdown === undefined ? null : JSON.stringify(patch.breakdown),
        now.toISOString(),
        id,
      );
  }

  setAffiliateUrl(id: number, url: string, now: Date) {
    this.db.prepare("UPDATE offers SET affiliate_url=?, updated_at=? WHERE id=?").run(url, now.toISOString(), id);
  }

  countOffersByStatus(): Record<string, number> {
    const rows = this.db.prepare("SELECT status, COUNT(*) n FROM offers GROUP BY status").all() as Row[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  // ---------- Histórico de preços ----------
  addPricePoint(m: Marketplace, externalId: string, price: number, at: Date) {
    this.db
      .prepare("INSERT INTO price_history (marketplace, external_id, price, observed_at) VALUES (?,?,?,?)")
      .run(m, externalId, price, at.toISOString());
  }

  priceHistory(m: Marketplace, externalId: string, since: Date): number[] {
    const rows = this.db
      .prepare(
        "SELECT price FROM price_history WHERE marketplace=? AND external_id=? AND observed_at >= ? ORDER BY observed_at",
      )
      .all(m, externalId, since.toISOString()) as Row[];
    return rows.map((r) => r.price);
  }

  // ---------- Grupos ----------
  createGroup(g: GroupInput, now: Date, isDemo = false): Group {
    const res = this.db
      .prepare(
        `INSERT INTO groups (name, platform, invite_link, external_id, admins, categories, marketplaces, audience,
         audience_source, window_start, window_end, min_interval_minutes, max_daily_posts, min_deal_score, template,
         affiliate_account, mode, status, repost_cooldown_days, is_demo, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        g.name,
        g.platform,
        g.inviteLink,
        g.externalId,
        JSON.stringify(g.admins),
        JSON.stringify(g.categories),
        JSON.stringify(g.marketplaces),
        g.audience,
        g.audienceSource,
        g.windowStart,
        g.windowEnd,
        g.minIntervalMinutes,
        g.maxDailyPosts,
        g.minDealScore,
        g.template,
        g.affiliateAccount,
        g.mode,
        g.status,
        g.repostCooldownDays,
        isDemo ? 1 : 0,
        now.toISOString(),
      );
    return this.getGroup(Number(res.lastInsertRowid))!;
  }

  updateGroup(id: number, g: Partial<GroupInput>): Group | undefined {
    const cur = this.getGroup(id);
    if (!cur) return undefined;
    const m = { ...cur, ...g };
    this.db
      .prepare(
        `UPDATE groups SET name=?, platform=?, invite_link=?, external_id=?, admins=?, categories=?, marketplaces=?,
         audience=?, audience_source=?, window_start=?, window_end=?, min_interval_minutes=?, max_daily_posts=?,
         min_deal_score=?, template=?, affiliate_account=?, mode=?, status=?, repost_cooldown_days=? WHERE id=?`,
      )
      .run(
        m.name,
        m.platform,
        m.inviteLink,
        m.externalId,
        JSON.stringify(m.admins),
        JSON.stringify(m.categories),
        JSON.stringify(m.marketplaces),
        m.audience,
        m.audienceSource,
        m.windowStart,
        m.windowEnd,
        m.minIntervalMinutes,
        m.maxDailyPosts,
        m.minDealScore,
        m.template,
        m.affiliateAccount,
        m.mode,
        m.status,
        m.repostCooldownDays,
        id,
      );
    return this.getGroup(id);
  }

  getGroup(id: number): Group | undefined {
    const r = this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as Row | undefined;
    return r ? toGroup(r) : undefined;
  }

  listGroups(): Group[] {
    return (this.db.prepare("SELECT * FROM groups ORDER BY id").all() as Row[]).map(toGroup);
  }

  // ---------- Publicações ----------
  createPublication(p: Omit<Publication, "id" | "publishedAt" | "error">, now: Date): Publication {
    const res = this.db
      .prepare(
        `INSERT INTO publications (offer_id, group_id, scheduled_for, status, message, tracking_code, image_url, hook, hook_source, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(p.offerId, p.groupId, p.scheduledFor, p.status, p.message, p.trackingCode, p.imageUrl, p.hook ?? null, p.hookSource ?? null, now.toISOString());
    return this.getPublication(Number(res.lastInsertRowid))!;
  }

  /** Chamadas usadas recentemente no grupo, para não repetir. */
  recentHooks(groupId: number, limit = 15): string[] {
    return (this.db.prepare("SELECT hook FROM publications WHERE group_id=? AND hook IS NOT NULL ORDER BY id DESC LIMIT ?").all(groupId, limit) as Row[]).map((r) => r.hook);
  }

  getPublication(id: number): Publication | undefined {
    const r = this.db.prepare("SELECT * FROM publications WHERE id = ?").get(id) as Row | undefined;
    return r ? toPublication(r) : undefined;
  }

  findPublicationByCode(code: string): Publication | undefined {
    const r = this.db.prepare("SELECT * FROM publications WHERE tracking_code = ?").get(code) as Row | undefined;
    return r ? toPublication(r) : undefined;
  }

  updatePublication(id: number, status: PublicationStatus, extra: { publishedAt?: string; error?: string } = {}) {
    this.db
      .prepare("UPDATE publications SET status=?, published_at=COALESCE(?, published_at), error=? WHERE id=?")
      .run(status, extra.publishedAt ?? null, extra.error ?? null, id);
  }

  listPublications(filter: { groupId?: number; statuses?: PublicationStatus[]; limit?: number } = {}): Publication[] {
    const where: string[] = [];
    const args: any[] = [];
    if (filter.groupId) {
      where.push("group_id = ?");
      args.push(filter.groupId);
    }
    if (filter.statuses?.length) {
      where.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
      args.push(...filter.statuses);
    }
    args.push(Math.min(filter.limit ?? 200, 1000));
    return (
      this.db
        .prepare(
          `SELECT * FROM publications ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY scheduled_for DESC LIMIT ?`,
        )
        .all(...args) as Row[]
    ).map(toPublication);
  }

  /** Publicações (agendadas ou feitas) de um grupo a partir de uma data — base dos limites diários e intervalo. */
  groupActivitySince(groupId: number, since: Date): Publication[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM publications WHERE group_id=? AND scheduled_for >= ?
           AND status IN ('scheduled','ready_for_admin','published','dry_run') ORDER BY scheduled_for`,
        )
        .all(groupId, since.toISOString()) as Row[]
    ).map(toPublication);
  }

  lastOfferPublicationInGroup(offerId: number, groupId: number): Publication | undefined {
    const r = this.db
      .prepare(
        `SELECT * FROM publications WHERE offer_id=? AND group_id=?
         AND status IN ('scheduled','ready_for_admin','published','dry_run') ORDER BY scheduled_for DESC LIMIT 1`,
      )
      .get(offerId, groupId) as Row | undefined;
    return r ? toPublication(r) : undefined;
  }

  // ---------- Cliques (agregados) ----------
  incrementClick(code: string, at: Date) {
    const hour = at.toISOString().slice(0, 13) + ":00";
    this.db
      .prepare(
        "INSERT INTO clicks (tracking_code, hour, count) VALUES (?,?,1) ON CONFLICT(tracking_code, hour) DO UPDATE SET count = count + 1",
      )
      .run(code, hour);
  }

  // ---------- Comissões e custos ----------
  upsertCommission(c: {
    marketplace: Marketplace;
    externalOrderRef: string;
    trackingCode?: string | null;
    offerExternalId?: string | null;
    category?: string | null;
    saleAmount: number;
    commissionAmount: number;
    status: CommissionStatus;
    occurredAt: string;
    isDemo?: boolean;
  }) {
    this.db
      .prepare(
        `INSERT INTO commissions (marketplace, external_order_ref, tracking_code, offer_external_id, category, sale_amount,
         commission_amount, status, occurred_at, is_demo) VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(marketplace, external_order_ref) DO UPDATE SET status=excluded.status,
         commission_amount=excluded.commission_amount, sale_amount=excluded.sale_amount`,
      )
      .run(
        c.marketplace,
        c.externalOrderRef,
        c.trackingCode ?? null,
        c.offerExternalId ?? null,
        c.category ?? null,
        c.saleAmount,
        c.commissionAmount,
        c.status,
        c.occurredAt,
        c.isDemo ? 1 : 0,
      );
  }

  addCost(c: { category: string; description: string; amount: number; occurredAt: string; isDemo?: boolean }) {
    this.db
      .prepare("INSERT INTO costs (category, description, amount, occurred_at, is_demo) VALUES (?,?,?,?,?)")
      .run(c.category, c.description, c.amount, c.occurredAt, c.isDemo ? 1 : 0);
  }

  // ---------- Configurações, agentes, auditoria, contadores ----------
  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as Row | undefined;
    return r ? parse(r.value, fallback) : fallback;
  }

  setSetting(key: string, value: unknown) {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, JSON.stringify(value));
  }

  recordAgentRun(agent: string, status: "ok" | "error" | "idle" | "disabled", result: string, at: Date) {
    this.db
      .prepare(
        `INSERT INTO agent_runs (agent, status, last_run_at, last_result) VALUES (?,?,?,?)
         ON CONFLICT(agent) DO UPDATE SET status=excluded.status, last_run_at=excluded.last_run_at, last_result=excluded.last_result`,
      )
      .run(agent, status, at.toISOString(), result.slice(0, 500));
  }

  listAgentRuns(): Row[] {
    return this.db.prepare("SELECT * FROM agent_runs ORDER BY agent").all() as Row[];
  }

  audit(action: string, detail: unknown, at: Date, actor: string | null = null) {
    this.db
      .prepare("INSERT INTO audit_log (action, detail, at, actor) VALUES (?,?,?,?)")
      .run(action, JSON.stringify(detail ?? null).slice(0, 2000), at.toISOString(), actor);
  }

  listAudit(o: { limit?: number; actor?: string; actions?: string[] } = {}): { id: number; action: string; detail: unknown; at: string; actor: string | null }[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (o.actor) (where.push("actor = ?"), args.push(o.actor));
    if (o.actions?.length) (where.push(`action IN (${o.actions.map(() => "?").join(",")})`), args.push(...o.actions));
    const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...args, o.limit ?? 200) as Row[];
    return rows.map((r) => ({ id: r.id, action: r.action, detail: parse(r.detail, null), at: r.at, actor: r.actor ?? null }));
  }

  // ---------- Usuários e sessões ----------
  private toUser(r: Row): User {
    return {
      id: r.id, username: r.username, displayName: r.display_name, role: r.role, active: Boolean(r.active),
      mustChangePassword: Boolean(r.must_change_password), mfaEnabled: Boolean(r.totp_enabled), createdAt: r.created_at, lastLoginAt: r.last_login_at ?? null,
    };
  }

  createUser(u: { username: string; displayName: string; role: Role; passwordHash: string; mustChangePassword: boolean }, at: Date): User {
    const r = this.db
      .prepare("INSERT INTO users (username, display_name, role, password_hash, must_change_password, created_at) VALUES (?,?,?,?,?,?) RETURNING *")
      .get(u.username, u.displayName, u.role, u.passwordHash, u.mustChangePassword ? 1 : 0, at.toISOString()) as Row;
    return this.toUser(r);
  }

  listUsers(): User[] {
    return (this.db.prepare("SELECT * FROM users ORDER BY active DESC, username").all() as Row[]).map((r) => this.toUser(r));
  }

  getUser(id: number): User | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE id=?").get(id) as Row | undefined;
    return r ? this.toUser(r) : undefined;
  }

  /** Inclui o hash da senha: só para o login. */
  findUserForLogin(username: string): (User & { passwordHash: string }) | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE username=?").get(username) as Row | undefined;
    return r ? { ...this.toUser(r), passwordHash: r.password_hash } : undefined;
  }

  getPasswordHash(id: number): string | undefined {
    return (this.db.prepare("SELECT password_hash FROM users WHERE id=?").get(id) as Row | undefined)?.password_hash;
  }

  updateUser(id: number, f: { displayName?: string; role?: Role; active?: boolean }) {
    const cur = this.getUser(id);
    if (!cur) return undefined;
    this.db
      .prepare("UPDATE users SET display_name=?, role=?, active=? WHERE id=?")
      .run(f.displayName ?? cur.displayName, f.role ?? cur.role, (f.active ?? cur.active) ? 1 : 0, id);
    return this.getUser(id);
  }

  setPassword(id: number, passwordHash: string, mustChange: boolean) {
    this.db.prepare("UPDATE users SET password_hash=?, must_change_password=? WHERE id=?").run(passwordHash, mustChange ? 1 : 0, id);
  }

  countActiveAdmins(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND active=1").get() as Row).n;
  }

  createSession(tokenHash: string, userId: number, at: Date, expiresAt: Date) {
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(at.toISOString());
    this.db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)").run(tokenHash, userId, at.toISOString(), expiresAt.toISOString());
    this.db.prepare("UPDATE users SET last_login_at=? WHERE id=?").run(at.toISOString(), userId);
  }

  /** Sessão válida de usuário ativo, ou undefined. */
  findSession(tokenHash: string, at: Date): (User & { expiresAt: string }) | undefined {
    const r = this.db
      .prepare("SELECT u.*, s.expires_at AS s_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash=? AND s.expires_at > ? AND u.active=1")
      .get(tokenHash, at.toISOString()) as Row | undefined;
    return r ? { ...this.toUser(r), expiresAt: r.s_expires } : undefined;
  }

  deleteSession(tokenHash: string) {
    this.db.prepare("DELETE FROM sessions WHERE token_hash=?").run(tokenHash);
  }

  // ---------- Verificação em duas etapas ----------
  getMfa(id: number): { secret: string | null; pendingSecret: string | null; enabled: boolean; lastStep: number } | undefined {
    const r = this.db.prepare("SELECT totp_secret, totp_pending_secret, totp_enabled, totp_last_step FROM users WHERE id=?").get(id) as Row | undefined;
    return r ? { secret: r.totp_secret ?? null, pendingSecret: r.totp_pending_secret ?? null, enabled: Boolean(r.totp_enabled), lastStep: r.totp_last_step ?? -1 } : undefined;
  }

  setPendingMfa(id: number, secret: string | null) {
    this.db.prepare("UPDATE users SET totp_pending_secret=? WHERE id=?").run(secret, id);
  }

  enableMfa(id: number, secret: string, step: number, recoveryHashes: string[]) {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE users SET totp_secret=?, totp_pending_secret=NULL, totp_enabled=1, totp_last_step=? WHERE id=?").run(secret, step, id);
      this.replaceRecoveryCodes(id, recoveryHashes);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  disableMfa(id: number) {
    this.db.prepare("UPDATE users SET totp_secret=NULL, totp_pending_secret=NULL, totp_enabled=0, totp_last_step=NULL WHERE id=?").run(id);
    this.db.prepare("DELETE FROM recovery_codes WHERE user_id=?").run(id);
  }

  setMfaLastStep(id: number, step: number) {
    this.db.prepare("UPDATE users SET totp_last_step=? WHERE id=?").run(step, id);
  }

  replaceRecoveryCodes(id: number, hashes: string[]) {
    this.db.prepare("DELETE FROM recovery_codes WHERE user_id=?").run(id);
    const ins = this.db.prepare("INSERT INTO recovery_codes (user_id, code_hash) VALUES (?,?)");
    for (const h of hashes) ins.run(id, h);
  }

  /** Marca o código como usado; false se não existe ou já foi usado. */
  useRecoveryCode(id: number, hash: string, at: Date): boolean {
    return this.db.prepare("UPDATE recovery_codes SET used_at=? WHERE user_id=? AND code_hash=? AND used_at IS NULL").run(at.toISOString(), id, hash).changes === 1;
  }

  recoveryCodesLeft(id: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id=? AND used_at IS NULL").get(id) as Row).n;
  }

  /** Encerra as sessões do usuário (todas, ou todas menos a atual). */
  deleteUserSessions(userId: number, exceptTokenHash?: string) {
    this.db.prepare("DELETE FROM sessions WHERE user_id=? AND token_hash != ?").run(userId, exceptTokenHash ?? "");
  }

  incrCounter(metric: string, at: Date, by = 1) {
    this.db
      .prepare(
        "INSERT INTO pipeline_counters (day, metric, value) VALUES (?,?,?) ON CONFLICT(day, metric) DO UPDATE SET value = value + excluded.value",
      )
      .run(at.toISOString().slice(0, 10), metric, by);
  }

  counterOnDay(metric: string, at: Date): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(value),0) n FROM pipeline_counters WHERE metric=? AND day=?").get(metric, at.toISOString().slice(0, 10)) as Row;
    return r.n;
  }

  counterTotal(metric: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(value),0) n FROM pipeline_counters WHERE metric=?").get(metric) as Row;
    return r.n;
  }
}
