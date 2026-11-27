import type { FastifyInstance } from "fastify";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { Role } from "../../src/domain/types";
import { seedDemo } from "../../src/db/seed";
import { hashPassword } from "../../src/security/auth";
import { createAlerting } from "../../src/ops/runtime";
import { buildApp } from "../../src/server/app";
import { TOKEN, makeCtx } from "../helpers";

/**
 * Servidor real (porta efêmera, banco em memória, relógio fixo às 12h de Brasília, dados DEMO) e
 * Chromium headless. Nada sai da máquina: as fontes do Google são bloqueadas e PUBLISH_ENABLED=false.
 */
export async function startDashboard() {
  const h = makeCtx();
  seedDemo(h.ctx);
  const app: FastifyInstance = buildApp(h.ctx, createAlerting(h.ctx, {}).ops); // monitor sem canal: alertas só no painel
  await app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const browser: Browser = await chromium.launch();

  const addUser = async (username: string, role: Role, password: string, mustChange = false) =>
    h.ctx.repo.createUser({ username, displayName: `${username[0].toUpperCase()}${username.slice(1)} Teste`, role, passwordHash: await hashPassword(password), mustChangePassword: mustChange }, h.ctx.clock());

  /** Abre uma aba isolada (sem sessão) e coleta erros de JavaScript da página. */
  const open = async (viewport = { width: 1280, height: 860 }): Promise<{ page: Page; context: BrowserContext; errors: string[] }> => {
    const context = await browser.newContext({ viewport, locale: "pt-BR", timezoneId: "America/Sao_Paulo" });
    await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(base + "/");
    return { page, context, errors };
  };

  const login = async (page: Page, username: string, password: string) => {
    await page.locator("#username").fill(username);
    await page.locator("#password").fill(password);
    await page.locator("#login-form").getByRole("button", { name: "Entrar", exact: true }).click();
  };

  const close = async () => {
    await browser.close();
    await app.close();
  };

  return { ...h, base, app, browser, addUser, open, login, close, TOKEN };
}
