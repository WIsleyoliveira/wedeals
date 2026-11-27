import { describe, expect, it, vi } from "vitest";
import { OllamaProvider, type CompletionRequest, type TextProvider } from "../../src/ai/provider";
import { runCycle } from "../../src/brain/pipeline";
import { seedDemo } from "../../src/db/seed";
import { collectIssues } from "../../src/ops/monitor";
import { buildApp } from "../../src/server/app";
import { commercialInsights } from "../../src/brain/insights";
import { TOKEN } from "../helpers";
import { FALLBACK_HOOKS, acceptHook, fallbackHook, generateHooks, pickHook, similarHooks } from "../../src/messages/generator";
import { makeCtx, offer } from "../helpers";

/** IA de mentira que devolve sempre o mesmo texto e conta as chamadas. */
const fakeAI = (reply: string | null | ((r: CompletionRequest) => string | null)) => {
  const calls: CompletionRequest[] = [];
  const ai: TextProvider = {
    name: "ollama",
    model: "teste",
    lastError: reply === null ? "Ollama indisponível: connection refused" : null,
    complete: async (r) => (calls.push(r), typeof reply === "function" ? reply(r) : reply),
  };
  return { ai, calls };
};

describe("chamadas: checagem de fatos", () => {
  it("limpa numeração e aspas; recusa números, urgência, exclusividade, preço e inglês", () => {
    expect(acceptHook("1. Seu café da manhã agradece")).toBe("Seu café da manhã agradece");
    expect(acceptHook("- 🎧 Seu som sem barulho em volta")).toBe("🎧 Seu som sem barulho em volta");
    expect(acceptHook("“Cozinha prática sem esforço”")).toBe("Cozinha prática sem esforço");
    expect(acceptHook("🗑️ Agora as gavetas ficam arrumadas")).toBe("Agora as gavetas ficam arrumadas"); // emoji fora da lista sai
    expect(acceptHook("🗿️ Você não ouve mais ruído")).toBe("Você não ouve mais ruído");
    expect(acceptHook("👗 Estampa leve pros dias quentes")).toBe("👗 Estampa leve pros dias quentes");
    for (const bad of ["Últimas unidades, corre!", "Só hoje nesse valor", "Oferta exclusiva pra você", "O menor preço da internet", "Imperdível demais", "Best deal now", "Leve 2 pague 1", "Use o cupom e economize", "Sempre a melhor opção", "Produto de alta qualidade", "Com preço reduzido", "O mais vendido da loja", "Vende-se fones bluetooth"])
      expect(acceptHook(bad), bad).toBeNull();
    expect(acceptHook("uma frase longa demais com muitas palavras que não cabe na chamada do grupo")).toBeNull();
  });

  it("detecta chamadas parecidas, ignorando emoji e acento", () => {
    expect(similarHooks("🔥 Cozinha prática sem esforço", "Cozinha pratica sem esforço!")).toBe(true);
    expect(similarHooks("Cozinha prática sem esforço", "Som potente para treinar")).toBe(false);
    expect(pickHook(["Cozinha prática sem esforço", "Som potente para treinar"], ["cozinha pratica sem esforco"])).toBe("Som potente para treinar");
  });

  it("modelo pronto não repete o que o grupo viu por último", () => {
    const o = offer({ id: 3 });
    const first = fallbackHook(o, []);
    expect(fallbackHook(o, [first])).not.toBe(first);
    expect(FALLBACK_HOOKS).toContain(fallbackHook(o, FALLBACK_HOOKS.slice(0, 9)));
    expect(fallbackHook(o, FALLBACK_HOOKS.slice(0, 9))).toBe(FALLBACK_HOOKS[9]);
  });
});

describe("chamadas: geração pela IA", () => {
  it("pede 3 variações numa chamada, com as recentes para evitar; devolve só as aprovadas", async () => {
    const { ai, calls } = fakeAI("1. 🍳 Cozinha prática sem esforço\n2. Só hoje com 50% off\n3. Seu café merece isso\n4. Cozinha pratica sem esforco");
    const out = await generateHooks(ai, offer({ title: "Cafeteira elétrica *Premium*", category: "casa" }), ["Achado para sua casa"]);
    expect(out).toEqual(["🍳 Cozinha prática sem esforço", "Seu café merece isso"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toMatch(/NUNCA use números/);
    expect(calls[0].user).toContain("Cafeteira elétrica Premium"); // sem marcação
    expect(calls[0].user).toContain("- Achado para sua casa");
  });

  it("IA fora do ar: null (para usar modelo pronto e registrar o erro)", async () => {
    expect(await generateHooks(fakeAI(null).ai, offer())).toBeNull();
  });

  it("Ollama: usa /api/chat, mantém o modelo carregado e explica modelo não instalado", async () => {
    const bodies: any[] = [];
    const ok = new OllamaProvider("http://ollama:11434/", "llama3.1:8b", async (url, init) => {
      bodies.push({ url, ...JSON.parse(String(init!.body)) });
      return Response.json({ message: { role: "assistant", content: " Frase boa \n" } });
    });
    expect(await ok.complete({ system: "S", user: "U" })).toBe("Frase boa");
    expect(bodies[0]).toMatchObject({ url: "http://ollama:11434/api/chat", model: "llama3.1:8b", stream: false, keep_alive: "30m", messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }] });

    const missing = new OllamaProvider("http://o", "qwen2.5:3b", async () => new Response('{"error":"model \\"qwen2.5:3b\\" not found, try pulling it first"}', { status: 404 }));
    expect(await missing.complete({ system: "", user: "" })).toBeNull();
    expect(missing.lastError).toBe('Ollama HTTP 404 (modelo qwen2.5:3b não instalado: rode "ollama pull qwen2.5:3b")');

    const down = new OllamaProvider("http://o", "m", async () => { throw new TypeError("fetch failed"); });
    expect(await down.complete({ system: "", user: "" })).toBeNull();
    expect(down.lastError).toBe("Ollama indisponível: fetch failed");
  });
});

describe("chamadas no ciclo do Mega Brain", () => {
  it("uma ida à IA por oferta; cada grupo recebe uma chamada diferente; origem registrada", async () => {
    let n = 0;
    const { ai, calls } = fakeAI(() => { n++; return `Boa escolha 10 vezes\nAchado prático ${"abcdefghij"[n % 10]}x para o dia\nVale conferir esse item ${"klmnopqrst"[n % 10]}y\nUm presente que agrada ${"uvwxyzabcd"[n % 10]}z`; });
    const { ctx } = makeCtx({ ai });
    seedDemo(ctx);
    await runCycle(ctx);
    const pubs = ctx.repo.listPublications({ limit: 500 });
    expect(pubs.length).toBeGreaterThan(0);
    const offersWithPubs = new Set(pubs.map((p) => p.offerId));
    expect(calls.length).toBe(offersWithPubs.size); // não chama a IA uma vez por grupo
    for (const p of pubs) {
      expect(p.hookSource).toBe("ia");
      expect(p.message.startsWith(p.hook!)).toBe(true);
      expect(p.hook).not.toMatch(/\d/);
    }
    // mesma oferta em grupos diferentes: chamadas diferentes
    for (const id of offersWithPubs) {
      const hooks = pubs.filter((p) => p.offerId === id).map((p) => p.hook);
      expect(new Set(hooks).size).toBe(hooks.length);
    }
    expect(ctx.repo.getSetting<any>("ai.status", {}).lastOkAt).toBeTruthy();
  });

  it("IA fora do ar: publica com modelo pronto, sem repetir no grupo, e registra o erro", async () => {
    const { ai } = fakeAI(null);
    const { ctx } = makeCtx({ ai });
    seedDemo(ctx);
    await runCycle(ctx);
    const pubs = ctx.repo.listPublications({ limit: 500 });
    expect(pubs.length).toBeGreaterThan(0);
    expect(pubs.every((p) => p.hookSource === "modelo" && FALLBACK_HOOKS.includes(p.hook!))).toBe(true);
    const byGroup = new Map<number, string[]>();
    for (const p of [...pubs].reverse()) byGroup.set(p.groupId, [...(byGroup.get(p.groupId) ?? []), p.hook!]);
    for (const hooks of byGroup.values()) for (let i = 1; i < hooks.length; i++) expect(hooks[i]).not.toBe(hooks[i - 1]);
    expect(ctx.repo.getSetting<any>("ai.status", {})).toMatchObject({ lastError: "Ollama indisponível: connection refused" });
  });

  it("sem IA configurada: modelo pronto e nenhum contador de IA", async () => {
    const { ctx } = makeCtx();
    seedDemo(ctx);
    await runCycle(ctx);
    expect(ctx.repo.listPublications({ limit: 5 }).every((p) => p.hookSource === "modelo")).toBe(true);
    expect(ctx.repo.getSetting("ai.status", null)).toBeNull();
  });

  it("respeita a cota diária da IA", async () => {
    const complete = vi.fn().mockResolvedValue("Achado prático para o dia");
    const { ctx } = makeCtx({ ai: { name: "ollama", complete }, cfg: { ai: { provider: "ollama", ollamaUrl: "", ollamaModel: "", dailyBudgetCalls: 1, timeoutMs: 1000 } } });
    seedDemo(ctx);
    await runCycle(ctx);
    expect(complete.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("IA no painel e nos alertas", () => {
  it("alerta quando a IA para de responder e some quando volta", async () => {
    let up = false;
    const ai: TextProvider = { name: "ollama", model: "m", get lastError() { return up ? null : "Ollama indisponível: fetch failed"; }, complete: async () => (up ? "Achado prático para o dia" : null) };
    const { ctx, advance } = makeCtx({ ai });
    seedDemo(ctx);
    await runCycle(ctx);
    const issue = collectIssues(ctx, ctx.clock(), ctx.clock()).find((i) => i.key === "ia:indisponivel");
    expect(issue?.message).toMatch(/modelos prontos.*fetch failed/);

    const app = buildApp(ctx);
    const integ = (await app.inject({ url: "/api/integrations", headers: { authorization: `Bearer ${TOKEN}` } })).json();
    expect(integ.ai).toMatchObject({ provider: "ollama", model: "m", status: { lastError: "Ollama indisponível: fetch failed" } });
    expect(integ.ai.today.unavailable).toBeGreaterThan(0);

    up = true;
    advance(60_000);
    ctx.repo.updateOfferEvaluation(ctx.repo.listOffers({ status: "queued", limit: 1 })[0].id, { status: "approved" }, ctx.clock());
    ctx.repo.db.prepare("DELETE FROM publications").run();
    await runCycle(ctx);
    expect(collectIssues(ctx, ctx.clock(), ctx.clock()).some((i) => i.key === "ia:indisponivel")).toBe(false);
  });

  it("inteligência compara cliques de chamadas da IA e de modelos prontos", async () => {
    const { ctx } = makeCtx({ ai: fakeAI("Achado prático para o dia\nVale conferir esse item\nUm presente que agrada").ai });
    seedDemo(ctx);
    await runCycle(ctx);
    const pubs = ctx.repo.listPublications({ limit: 500 });
    for (const p of pubs) ctx.repo.updatePublication(p.id, "published", { publishedAt: ctx.clock().toISOString() });
    ctx.repo.incrementClick(pubs[0].trackingCode, ctx.clock());
    const i = commercialInsights(ctx.repo);
    expect(i.byHookSource.map((r) => r.key)).toEqual(["ia"]);
    expect(i.byHookSource[0]).toMatchObject({ publications: pubs.length, clicks: 1 });
  });
});
