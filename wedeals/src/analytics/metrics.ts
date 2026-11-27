import { z } from "zod";
import type { Repo } from "../db/repo";
import { MARKETPLACES } from "../domain/types";

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Indicadores do dashboard principal — calculados apenas a partir de dados registrados. */
export function dashboardMetrics(repo: Repo, now: Date) {
  const db = repo.db;
  const one = (sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as any) ?? {};
  const byStatus = repo.countOffersByStatus();

  const commissions = Object.fromEntries(
    (db.prepare("SELECT status, COALESCE(SUM(commission_amount),0) v, COUNT(*) n FROM commissions GROUP BY status").all() as any[]).map(
      (r) => [r.status, { amount: round2(r.v), count: r.n }],
    ),
  );
  const totalCosts = round2(one("SELECT COALESCE(SUM(amount),0) v FROM costs").v);
  const received = commissions.paid?.amount ?? 0;
  const approvedComm = commissions.approved?.amount ?? 0;

  const perMarketplace = MARKETPLACES.map((m) => {
    const o = one("SELECT COUNT(*) n FROM offers WHERE marketplace=?", m);
    const p = one(
      "SELECT COUNT(*) n FROM publications p JOIN offers o ON o.id=p.offer_id WHERE o.marketplace=? AND p.status='published'",
      m,
    );
    const c = one(
      `SELECT COALESCE(SUM(c.count),0) n FROM clicks c JOIN publications p ON p.tracking_code=c.tracking_code
       JOIN offers o ON o.id=p.offer_id WHERE o.marketplace=?`,
      m,
    );
    const k = one(
      "SELECT COUNT(*) sales, COALESCE(SUM(commission_amount),0) v FROM commissions WHERE marketplace=? AND status!='cancelled'",
      m,
    );
    return { marketplace: m, offers: o.n, published: p.n, clicks: c.n, sales: k.sales, commission: round2(k.v) };
  });

  // Desempenho por grupo: só com atribuição confiável (comissão com tracking_code de publicação do grupo).
  const perGroup = (
    db
      .prepare(
        `SELECT g.id, g.name, g.platform, g.status, g.audience, g.audience_source,
          (SELECT COUNT(*) FROM publications p WHERE p.group_id=g.id AND p.status='published') published,
          (SELECT COALESCE(SUM(c.count),0) FROM clicks c JOIN publications p ON p.tracking_code=c.tracking_code WHERE p.group_id=g.id) clicks,
          (SELECT COUNT(*) FROM commissions m JOIN publications p ON p.tracking_code=m.tracking_code WHERE p.group_id=g.id AND m.status!='cancelled') attributed_sales,
          (SELECT COALESCE(SUM(m.commission_amount),0) FROM commissions m JOIN publications p ON p.tracking_code=m.tracking_code WHERE p.group_id=g.id AND m.status!='cancelled') attributed_commission
         FROM groups g ORDER BY g.id`,
      )
      .all() as any[]
  ).map((r) => ({ ...r, attributed_commission: round2(r.attributed_commission) }));

  const upcoming = db
    .prepare(
      `SELECT p.id, p.scheduled_for, p.status, g.name group_name, o.title, o.marketplace, o.deal_score
       FROM publications p JOIN groups g ON g.id=p.group_id JOIN offers o ON o.id=p.offer_id
       WHERE p.status IN ('scheduled','ready_for_admin') ORDER BY p.scheduled_for LIMIT 20`,
    )
    .all();

  const demo = one(
    "SELECT (SELECT COUNT(*) FROM offers WHERE is_demo=1) + (SELECT COUNT(*) FROM groups WHERE is_demo=1) + (SELECT COUNT(*) FROM commissions WHERE is_demo=1) n",
  ).n;

  return {
    generatedAt: now.toISOString(),
    containsDemoData: demo > 0,
    offers: {
      researched: repo.counterTotal("researched"),
      inDatabase: Object.values(byStatus).reduce((a: number, b) => a + (b as number), 0),
      approved: (byStatus.approved ?? 0) + (byStatus.queued ?? 0) + (byStatus.published ?? 0),
      awaitingLink: byStatus.awaiting_link ?? 0,
      rejected: byStatus.rejected ?? 0,
      published: one("SELECT COUNT(*) n FROM publications WHERE status='published'").n,
      byStatus,
    },
    queue: {
      scheduled: one("SELECT COUNT(*) n FROM publications WHERE status='scheduled'").n,
      readyForAdmin: one("SELECT COUNT(*) n FROM publications WHERE status='ready_for_admin'").n,
      dryRun: one("SELECT COUNT(*) n FROM publications WHERE status='dry_run'").n,
      failed: one("SELECT COUNT(*) n FROM publications WHERE status='failed'").n,
    },
    upcoming,
    groups: {
      active: one("SELECT COUNT(*) n FROM groups WHERE status='active'").n,
      paused: one("SELECT COUNT(*) n FROM groups WHERE status='paused'").n,
      audienceInformed: one("SELECT COALESCE(SUM(audience),0) n FROM groups WHERE audience_source='informed'").n,
      audienceVerified: one("SELECT COALESCE(SUM(audience),0) n FROM groups WHERE audience_source='official'").n,
    },
    clicks: one("SELECT COALESCE(SUM(count),0) n FROM clicks").n,
    sales: { attributed: one("SELECT COUNT(*) n FROM commissions WHERE status!='cancelled'").n },
    commissions: {
      pending: commissions.pending?.amount ?? 0,
      approved: approvedComm,
      paid: received,
      cancelled: commissions.cancelled?.amount ?? 0,
    },
    costs: totalCosts,
    // Resultado operacional = comissões recebidas − custos (aprovadas a receber mostradas à parte).
    operatingResult: round2(received - totalCosts),
    projectedResult: round2(received + approvedComm - totalCosts),
    perMarketplace,
    perGroup,
  };
}

export const CommissionRowSchema = z.object({
  marketplace: z.enum(MARKETPLACES),
  order_ref: z.string().min(1).max(120),
  tracking_code: z.string().max(40).optional().or(z.literal("")),
  offer_external_id: z.string().max(100).optional().or(z.literal("")),
  category: z.string().max(80).optional().or(z.literal("")),
  sale_amount: z.coerce.number().min(0),
  commission_amount: z.coerce.number().min(0),
  status: z.enum(["pending", "approved", "paid", "cancelled"]),
  occurred_at: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "data inválida"),
});

/** Importa relatório de comissões exportado dos painéis de afiliados. Sem dados de compradores. */
export function importCommissions(repo: Repo, rows: Record<string, unknown>[]) {
  const errors: { row: number; error: string }[] = [];
  let imported = 0;
  rows.slice(0, 20000).forEach((raw, i) => {
    const p = CommissionRowSchema.safeParse(raw);
    if (!p.success) return void errors.push({ row: i + 1, error: p.error.issues.map((x) => `${x.path}: ${x.message}`).join("; ") });
    const r = p.data;
    // Categoria herdada da publicação quando houver atribuição.
    let category = r.category || null;
    if (!category && r.tracking_code) {
      const row = repo.db
        .prepare("SELECT o.category FROM publications p JOIN offers o ON o.id=p.offer_id WHERE p.tracking_code=?")
        .get(r.tracking_code) as any;
      category = row?.category ?? null;
    }
    repo.upsertCommission({
      marketplace: r.marketplace,
      externalOrderRef: r.order_ref,
      trackingCode: r.tracking_code || null,
      offerExternalId: r.offer_external_id || null,
      category,
      saleAmount: r.sale_amount,
      commissionAmount: r.commission_amount,
      status: r.status,
      occurredAt: new Date(r.occurred_at).toISOString(),
    });
    imported++;
  });
  return { imported, errors };
}
