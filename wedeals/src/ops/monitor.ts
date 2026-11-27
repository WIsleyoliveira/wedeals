import type { BrainContext } from "../brain/pipeline";
import type { AlertManager, Issue } from "./alerts";

/**
 * Tempo máximo sem execução de cada agente do Mega Brain antes de alertar. Os intervalos do worker são
 * 2–15 min (aprendizado: 6h); os limites dão folga para ciclos lentos.
 */
export const STALE_AFTER_MIN: Record<string, number> = {
  distribuicao: 10,
  classificacao: 15,
  fila: 30,
  pesquisa: 60,
  aprendizado: 13 * 60,
};

const AGENT_LABEL: Record<string, string> = {
  distribuicao: "Distribuição",
  classificacao: "Classificação",
  fila: "Fila",
  pesquisa: "Pesquisa",
  aprendizado: "Aprendizado",
};

/** Problemas atuais, a partir do que o worker registra no banco. */
export function collectIssues(ctx: BrainContext, now: Date, startedAt: Date): Issue[] {
  const issues: Issue[] = [];
  const runs = new Map(ctx.repo.listAgentRuns().map((r) => [String(r.agent), r]));
  const sinceStartMin = (now.getTime() - startedAt.getTime()) / 60_000;

  const stale: { agent: string; text: string }[] = [];
  for (const [agent, limit] of Object.entries(STALE_AFTER_MIN)) {
    const r = runs.get(agent);
    const last = r?.last_run_at ? new Date(String(r.last_run_at)) : null;
    // sem registro: só alerta depois do mesmo limite contado a partir da subida do app
    const ageMin = last ? (now.getTime() - last.getTime()) / 60_000 : sinceStartMin;
    if (ageMin > limit) stale.push({ agent, text: `${AGENT_LABEL[agent]} (${last ? `sem rodar há ${Math.round(ageMin)} min` : "nunca rodou"})` });
    else if (r?.status === "error")
      issues.push({ key: `agente:${agent}:erro`, message: `${AGENT_LABEL[agent]} com erro: ${String(r.last_result ?? "").slice(0, 300)}` });
  }
  if (stale.length === Object.keys(STALE_AFTER_MIN).length) {
    issues.push({ key: "worker:parado", message: `Worker do Mega Brain parado: nenhum agente rodou no tempo esperado (${stale.map((x) => x.text).join(", ")})` });
  } else {
    for (const x of stale) issues.push({ key: `agente:${x.agent}:atrasado`, message: `Agente atrasado: ${x.text}` });
  }

  // publicações automáticas que falharam na última hora
  const failed = ctx.repo.db
    .prepare("SELECT COUNT(*) AS n FROM publications WHERE status='failed' AND scheduled_for >= ?")
    .get(new Date(now.getTime() - 3_600_000).toISOString()) as { n: number };
  if (failed.n > 0) issues.push({ key: "publicacoes:falhas", message: `${failed.n} publicação(ões) automática(s) falharam na última hora` });

  return issues;
}

export function startMonitor(ctx: BrainContext, alerts: AlertManager, everyMs = 5 * 60_000) {
  const startedAt = ctx.clock();
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const now = ctx.clock();
      const r = await alerts.update(collectIssues(ctx, now, startedAt), now);
      if (r.sent.length || r.resolved.length || r.sendError) ctx.repo.audit("alerts.update", r, now);
    } catch (e) {
      console.error(`[monitor] ${(e as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, everyMs);
  return { tick, stop: () => clearInterval(timer) };
}
