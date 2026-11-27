import { pathToFileURL } from "node:url";
import { dispatchDue, evaluate, learn, planQueue, research, type BrainContext } from "../brain/pipeline";
import { loadConfig } from "../config";
import { buildContext } from "../context";

/**
 * Worker contínuo do Mega Brain. Pesquisa e classificação rodam 24h (inclusive madrugada), limitadas
 * pelas cotas; a distribuição só entrega dentro da janela de cada grupo.
 */
export const INTERVALS = {
  researchMs: 15 * 60_000,
  evaluateMs: 2 * 60_000,
  queueMs: 5 * 60_000,
  dispatchMs: 60_000,
  learnMs: 6 * 60 * 60_000,
};

export function startWorker(ctx: BrainContext, intervals = INTERVALS) {
  const running = new Set<string>();
  const guard = (name: string, fn: () => Promise<unknown> | unknown) => async () => {
    if (running.has(name)) return; // evita sobreposição de ciclos
    running.add(name);
    try {
      await fn();
    } catch (e) {
      ctx.repo.recordAgentRun(name, "error", (e as Error).message, ctx.clock());
    } finally {
      running.delete(name);
    }
  };
  const timers = [
    setInterval(guard("pesquisa", () => research(ctx)), intervals.researchMs),
    setInterval(guard("classificacao", () => evaluate(ctx)), intervals.evaluateMs),
    setInterval(guard("fila", () => planQueue(ctx)), intervals.queueMs),
    setInterval(guard("distribuicao", () => dispatchDue(ctx)), intervals.dispatchMs),
    setInterval(guard("aprendizado", () => learn(ctx)), intervals.learnMs),
  ];
  return () => timers.forEach(clearInterval);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ctx = buildContext(loadConfig());
  console.log("Worker do Mega Brain iniciado");
  startWorker(ctx);
}
