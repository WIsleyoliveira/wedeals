import { expect as pw } from "playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startDashboard } from "./fixture";

let d: Awaited<ReturnType<typeof startDashboard>>;
beforeAll(async () => {
  d = await startDashboard();
  await d.addUser("chefe", "admin", "senha-do-chefe-123");
  await d.addUser("operadora", "operador", "senha-da-operadora-1");
  await d.addUser("novata", "operador", "provisoria-novata-1", true);
});
afterAll(() => d?.close());

describe("dashboard no navegador", () => {
  it("login: senha errada mostra erro e não entra", async () => {
    const { page, context, errors } = await d.open();
    await d.login(page, "operadora", "senha-errada-123");
    await pw(page.locator("#login-error")).toHaveText("usuário ou senha inválidos");
    await pw(page.locator("#shell")).toBeHidden();
    expect(errors).toEqual([]);
    await context.close();
  });

  it("primeiro acesso: troca obrigatória da senha provisória, depois entra", async () => {
    const { page, context, errors } = await d.open();
    await d.login(page, "novata", "provisoria-novata-1");
    await pw(page.locator("#pwchange")).toBeVisible();
    await pw(page.locator("#pw-reason")).toContainText("senha provisória");
    await pw(page.locator("#pw-cancel")).toBeHidden(); // não dá para pular

    await page.locator("#pw-current").fill("provisoria-novata-1");
    await page.locator("#pw-new").fill("nova-senha-novata-1");
    await page.locator("#pw-confirm").fill("outra-coisa-12345");
    await page.getByRole("button", { name: "Salvar nova senha" }).click();
    await pw(page.locator("#pw-error")).toHaveText("As senhas não conferem");

    await page.locator("#pw-confirm").fill("nova-senha-novata-1");
    await page.getByRole("button", { name: "Salvar nova senha" }).click();
    await pw(page.locator("#shell")).toBeVisible();
    await pw(page.locator("#who-name")).toHaveText("Novata Teste");
    expect(errors).toEqual([]);
    await context.close();
  });

  it("operador: vê o dia a dia, sem abas nem formulários de administrador", async () => {
    const { page, context, errors } = await d.open();
    await d.login(page, "operadora", "senha-da-operadora-1");
    await pw(page.locator("#view-title")).toHaveText("Visão geral");
    await pw(page.locator("#kpis .kpi")).not.toHaveCount(0);
    await pw(page.locator("#demo-flag")).toBeVisible();
    await pw(page.locator("#publish-flag")).toHaveText("Publicação real desligada");
    await pw(page.locator("#nav").getByRole("button", { name: "Usuários" })).toBeHidden();
    await pw(page.locator("#nav").getByRole("button", { name: "Atividade" })).toBeHidden();

    await page.locator("#nav").getByRole("button", { name: "Grupos" }).click();
    await pw(page.locator("#groups-list .card").first()).toBeVisible();
    await pw(page.locator("#group-form")).toBeHidden();
    await page.locator("#nav").getByRole("button", { name: "Comissões e custos" }).click();
    await pw(page.locator("#cost-form")).toBeHidden();
    expect(errors).toEqual([]);
    await context.close();
  });

  it("fluxo assistido: rodar o ciclo, confirmar uma publicação e ver na atividade", async () => {
    const { page, context, errors } = await d.open();
    await d.login(page, "operadora", "senha-da-operadora-1");
    await page.getByRole("button", { name: "Rodar ciclo do Mega Brain" }).click();
    await pw(page.locator("#toast")).toContainText("Ciclo concluído");

    await page.locator("#nav").getByRole("button", { name: /Publicação assistida/ }).click();
    const cards = page.locator("#assisted-list .post");
    await pw(cards.first()).toBeVisible();
    const before = await cards.count();
    const first = cards.first();
    await pw(first.locator("pre")).toContainText("/r/"); // link rastreado na mensagem
    await pw(first.getByRole("link", { name: "Abrir grupo" })).toHaveAttribute("href", /^https:\/\/chat\.whatsapp\.com\//);
    await first.getByRole("button", { name: "Publicado ✓" }).click();
    await pw(page.locator("#toast")).toHaveText("Publicação confirmada");
    await pw(cards).toHaveCount(before - 1);

    const log = d.ctx.repo.listAudit({ actor: "operadora" });
    expect(log.some((e: any) => e.detail?.route === "POST /api/publications/:id/confirm")).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  });

  it("administrador: cria conta com senha gerada e vê o registro na Atividade", async () => {
    const { page, context, errors } = await d.open();
    await d.login(page, "chefe", "senha-do-chefe-123");
    await page.locator("#nav").getByRole("button", { name: "Usuários" }).click();
    const form = page.locator("#user-form");
    await form.locator('[name="displayName"]').fill("Bruno Silva");
    await form.locator('[name="username"]').fill("bruno.silva");
    await form.locator('[name="role"]').selectOption("operador");
    await page.getByRole("button", { name: "Gerar" }).click();
    const generated = await form.locator('[name="password"]').inputValue();
    expect(generated).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{1,4}){3}$/);
    await page.getByRole("button", { name: "Criar conta" }).click();

    await pw(page.locator("#users-notice")).toContainText(generated);
    const row = page.locator("#users-list tr", { hasText: "bruno.silva" });
    await pw(row).toContainText("aguardando 1º acesso");

    await page.locator("#nav").getByRole("button", { name: "Atividade" }).click();
    await pw(page.locator("#activity-list tbody tr").first()).toContainText("chefe");
    await pw(page.locator("#activity-list tbody tr").first()).toContainText("Criou conta");
    expect(errors).toEqual([]);
    await context.close();
  });

  it("desativar uma conta derruba a sessão aberta dela", async () => {
    await d.addUser("temporario", "operador", "senha-temporario-1");
    const op = await d.open();
    await d.login(op.page, "temporario", "senha-temporario-1");
    await pw(op.page.locator("#shell")).toBeVisible();

    const adm = await d.open();
    await d.login(adm.page, "chefe", "senha-do-chefe-123");
    await adm.page.locator("#nav").getByRole("button", { name: "Usuários" }).click();
    await adm.page.locator("#users-list tr", { hasText: "temporario" }).getByRole("button", { name: "Desativar" }).click();
    await pw(adm.page.locator("#users-list tr", { hasText: "temporario" })).toContainText("desativada");

    await op.page.locator("#nav").getByRole("button", { name: "Ofertas" }).click();
    await pw(op.page.locator("#login")).toBeVisible();
    await op.context.close();
    await adm.context.close();
  });

  it("conteúdo malicioso aparece como texto, sem executar", async () => {
    const { page, context, errors } = await d.open();
    await d.login(page, "chefe", "senha-do-chefe-123");
    await page.locator("#nav").getByRole("button", { name: "Grupos" }).click();
    const evil = `<img src=x onerror="window.__xss=1">Grupo`;
    await page.locator('#group-form [name="name"]').fill(evil);
    await page.getByRole("button", { name: "Cadastrar grupo" }).click();
    await pw(page.locator("#toast")).toHaveText("Grupo cadastrado");
    await pw(page.locator("#groups-list h2", { hasText: "onerror" })).toBeVisible();
    expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
    expect(await page.locator("#groups-list img").count()).toBe(0);
    expect(errors).toEqual([]);
    await context.close();
  });

  it("celular (375 px): sem rolagem horizontal e menu utilizável", async () => {
    const { page, context, errors } = await d.open({ width: 375, height: 812 });
    await d.login(page, "operadora", "senha-da-operadora-1");
    await pw(page.locator("#shell")).toBeVisible();
    for (const view of ["Visão geral", "Publicação assistida", "Ofertas", "Integrações e agentes"]) {
      await page.locator("#nav").getByRole("button", { name: new RegExp(view) }).click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, view).toBeLessThanOrEqual(0);
    }
    expect(errors).toEqual([]);
    await context.close();
  });

  it("alertas: contador no menu, problema ativo, verificar agora e resolvido no histórico", async () => {
    const agents = ["distribuicao", "classificacao", "fila", "pesquisa", "aprendizado"];
    const now = d.ctx.clock();
    for (const a of agents) d.ctx.repo.recordAgentRun(a, "ok", "", now);
    d.ctx.repo.recordAgentRun("pesquisa", "error", "shopee: HTTP 401 credencial recusada", now);

    const { page, context, errors } = await d.open();
    await d.login(page, "operadora", "senha-da-operadora-1");
    await page.locator("#nav").getByRole("button", { name: /Alertas/ }).click();
    await pw(page.locator(".all-clear")).toBeVisible(); // nenhuma verificação rodou ainda
    await pw(page.locator("#alerts-test")).toBeHidden(); // teste de alerta é só para admin
    await pw(page.locator("#alerts-meta")).toContainText("Nenhum canal configurado");

    await page.getByRole("button", { name: "Verificar agora" }).click();
    await pw(page.locator("#alerts-active .alert-item")).toHaveCount(1);
    await pw(page.locator("#alerts-active")).toContainText("Pesquisa com erro: shopee: HTTP 401");
    await pw(page.locator("#badge-alerts")).toHaveText("1");
    await pw(page.locator("#alerts-history tbody tr").first()).toContainText("Novo");

    d.ctx.repo.recordAgentRun("pesquisa", "ok", "3 ofertas", now);
    await page.getByRole("button", { name: "Verificar agora" }).click();
    await pw(page.locator(".all-clear")).toBeVisible();
    await pw(page.locator("#badge-alerts")).toBeHidden();
    await pw(page.locator("#alerts-history tbody tr").first()).toContainText("Resolvido");
    expect(errors).toEqual([]);
    await context.close();
  });

  it("sair encerra a sessão no servidor", async () => {
    const { page, context } = await d.open();
    await d.login(page, "operadora", "senha-da-operadora-1");
    await pw(page.locator("#shell")).toBeVisible();
    const token = await page.evaluate(() => sessionStorage.getItem("wedeals.token"));
    await page.getByRole("button", { name: "Sair" }).click();
    await pw(page.locator("#login")).toBeVisible();
    const res = await fetch(`${d.base}/api/dashboard`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
    await context.close();
  });
});
