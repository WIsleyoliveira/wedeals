// Dashboard WeDeals — todo conteúdo dinâmico entra via textContent/createElement, nunca como HTML bruto (proteção contra XSS).
const $ = (s) => document.querySelector(s);
const MK = { mercadolivre: "Mercado Livre", shopee: "Shopee", shein: "SHEIN" };
const brl = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const int = (v) => Number(v || 0).toLocaleString("pt-BR");
const dt = (s) => (s ? new Date(s).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—");

let token = null;
try { token = sessionStorage.getItem("wedeals.token"); } catch {}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const mount = (sel, ...nodes) => $(sel).replaceChildren(...nodes);

function table(cols, rows) {
  if (!rows.length) return h("p", { class: "empty" }, "Sem dados registrados ainda.");
  return h("div", { class: "table-wrap" },
    h("table", {}, h("thead", {}, h("tr", {}, cols.map((c) => h("th", {}, c[0])))),
      h("tbody", {}, rows.map((r) => h("tr", {}, cols.map((c) => { const v = c[1](r); return v instanceof Node ? h("td", { class: c[2] || "" }, v) : h("td", { class: c[2] || "" }, v ?? "—"); }))))));
}
const scoreTag = (s) => s == null ? "—" : h("span", { class: "score " + (s >= 75 ? "hi" : s >= 55 ? "mid" : "lo") }, Math.round(s));
const kpi = (label, value, cls = "") => h("div", { class: "kpi " + cls }, h("span", {}, label), h("strong", {}, value));

function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (bad ? " bad" : "");
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 5000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, ...(opts.body ? { "content-type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { logout(); throw new Error("Sessão expirada"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ? `${data.error}${data.issues ? ": " + data.issues.map((i) => `${i.path} ${i.message}`).join(", ") : ""}` : `HTTP ${res.status}`);
  return data;
}

// ---------- Views ----------
async function renderOverview() {
  const d = await api("/api/dashboard");
  $("#demo-flag").hidden = !d.containsDemoData;
  mount("#kpis",
    kpi("Ofertas pesquisadas", int(d.offers.researched)),
    kpi("Aprovadas", int(d.offers.approved), "good"),
    kpi("Rejeitadas", int(d.offers.rejected)),
    kpi("Publicadas", int(d.offers.published)),
    kpi("Próximas publicações", int(d.queue.scheduled + d.queue.readyForAdmin)),
    kpi("Grupos ativos", int(d.groups.active)),
    kpi("Audiência informada", int(d.groups.audienceInformed)),
    kpi("Audiência verificada", int(d.groups.audienceVerified)),
    kpi("Cliques", int(d.clicks), "accent"),
    kpi("Vendas atribuídas", int(d.sales.attributed)),
    kpi("Comissões pendentes", brl(d.commissions.pending)),
    kpi("Comissões aprovadas", brl(d.commissions.approved)),
    kpi("Comissões recebidas", brl(d.commissions.paid), "good"),
    kpi("Custos operacionais", brl(d.costs)),
    kpi("Resultado operacional", brl(d.operatingResult), d.operatingResult >= 0 ? "good accent" : "bad"),
  );
  mount("#mk-table", table(
    [["Marketplace", (r) => MK[r.marketplace]], ["Ofertas", (r) => int(r.offers)], ["Publicadas", (r) => int(r.published)], ["Cliques", (r) => int(r.clicks)], ["Vendas", (r) => int(r.sales)], ["Comissão", (r) => brl(r.commission)]],
    d.perMarketplace));
  mount("#upcoming", table(
    [["Quando", (r) => dt(r.scheduled_for)], ["Grupo", (r) => r.group_name], ["Oferta", (r) => r.title, "wrap"], ["Score", (r) => scoreTag(r.deal_score)], ["Status", (r) => r.status === "ready_for_admin" ? "aguardando admin" : "agendada"]],
    d.upcoming));
  mount("#group-perf", table(
    [["Grupo", (r) => r.name], ["Status", (r) => r.status], ["Audiência", (r) => r.audience == null ? "—" : `${int(r.audience)} (${r.audience_source === "official" ? "verificada" : "informada"})`], ["Publicações", (r) => int(r.published)], ["Cliques", (r) => int(r.clicks)], ["Vendas atrib.", (r) => int(r.attributed_sales)], ["Comissão atrib.", (r) => brl(r.attributed_commission)]],
    d.perGroup));
  mount("#queue", h("div", { class: "kpis" },
    kpi("Agendadas", int(d.queue.scheduled)), kpi("Aguardando admin", int(d.queue.readyForAdmin)),
    kpi("Simuladas (dry-run)", int(d.queue.dryRun)), kpi("Falhas", int(d.queue.failed), d.queue.failed ? "bad" : ""),
    kpi("Aguardando link", int(d.offers.awaitingLink))));
  setBadge("#badge-assisted", d.queue.readyForAdmin);
  setBadge("#badge-links", d.offers.awaitingLink);
}
function setBadge(sel, n) { const b = $(sel); b.textContent = n; b.hidden = !n; }

async function renderAssisted() {
  const list = await api("/api/assisted");
  if (!list.length) return mount("#assisted-list", h("p", { class: "empty" }, "Nenhuma mensagem aguardando. Quando chegar o horário de um grupo, ela aparece aqui."));
  mount("#assisted-list", ...list.map((p) => h("article", { class: "post" },
    h("div", { class: "meta" }, h("strong", {}, p.groupName), h("span", {}, `${MK[p.marketplace]} · ${dt(p.scheduledFor)}`)),
    p.imageUrl ? h("img", { src: p.imageUrl, alt: p.offerTitle, loading: "lazy", referrerpolicy: "no-referrer", onerror: (e) => e.target.remove() }) : null,
    h("pre", {}, p.message),
    h("div", { class: "actions" },
      h("button", { class: "btn small", onclick: async () => { await navigator.clipboard.writeText(p.message); toast("Mensagem copiada"); } }, "Copiar texto"),
      navigator.share ? h("button", { class: "btn small", onclick: () => navigator.share({ text: p.message }).catch(() => {}) }, "Compartilhar") : null,
      p.groupInviteLink ? h("a", { class: "btn small", href: p.groupInviteLink, target: "_blank", rel: "noopener noreferrer" }, "Abrir grupo") : null,
      h("button", { class: "btn small primary", onclick: () => act(`/api/publications/${p.id}/confirm`, "Publicação confirmada", renderAssisted) }, "Publicado ✓"),
      h("button", { class: "btn small danger", onclick: () => act(`/api/publications/${p.id}/skip`, "Descartada", renderAssisted) }, "Descartar")))));
}

async function act(path, okMsg, after, body) {
  try { await api(path, { method: "POST", body: body || {} }); toast(okMsg); await after?.(); }
  catch (e) { toast(e.message, true); }
}

async function renderGroups() {
  const groups = await api("/api/groups");
  mount("#groups-list", ...groups.map((g) => h("div", { class: "card" },
    h("div", { class: "topbar" },
      h("h2", {}, `${g.name} `, h("small", {}, `${g.platform === "whatsapp" ? "WhatsApp" : "Telegram"} · ${g.mode === "automatic" && g.platform === "telegram" ? "automático" : "assistido"}`)),
      h("div", { class: "actions" },
        h("span", { class: "pill " + (g.status === "active" ? "ok" : "off") }, g.status === "active" ? "ativo" : "pausado"),
        h("button", { class: "btn small", onclick: () => act(`/api/groups/${g.id}/${g.status === "active" ? "pause" : "resume"}`, "Grupo atualizado", renderGroups) }, g.status === "active" ? "Pausar" : "Retomar"))),
    g.platform === "whatsapp" && g.mode === "automatic" ? h("p", { class: "hint" }, "Sem integração oficial automática para grupos de WhatsApp: este grupo opera em modo assistido.") : null,
    table([["Janela", () => `${g.windowStart}–${g.windowEnd}`], ["Intervalo", () => `${g.minIntervalMinutes} min`], ["Máx./dia", () => g.maxDailyPosts], ["Score mín.", () => g.minDealScore], ["Categorias", () => g.categories.join(", ") || "todas"], ["Marketplaces", () => g.marketplaces.map((m) => MK[m]).join(", ") || "todos"], ["Participantes", () => g.audience == null ? "—" : int(g.audience)], ["Admins", () => g.admins.join(", ") || "—"]], [g]))));
}

async function renderOffers() {
  const status = $("#offer-filter").value;
  const [offers, groups] = await Promise.all([api("/api/offers" + (status ? `?status=${status}` : "")), api("/api/groups")]);
  const active = groups.filter((g) => g.status === "active");
  mount("#offers-list", h("div", { class: "card" }, table(
    [["Score", (o) => scoreTag(o.dealScore)], ["Oferta", (o) => o.title, "wrap"], ["Marketplace", (o) => MK[o.marketplace]], ["Preço", (o) => brl(o.price)], ["Categoria", (o) => o.category], ["Status", (o) => o.rejectReason ? `${o.status} · ${o.rejectReason}` : o.status, "wrap"],
     ["Ações", (o) => ["approved", "queued", "published"].includes(o.status) && active.length
       ? h("button", { class: "btn small", onclick: () => act(`/api/offers/${o.id}/distribute`, "Distribuição agendada nos grupos compatíveis", renderOffers, { groupIds: active.map((g) => g.id) }) }, "Distribuir")
       : ""]],
    offers)));
}

async function renderLinks() {
  const offers = await api("/api/offers?status=awaiting_link");
  if (!offers.length) return mount("#links-list", h("p", { class: "empty" }, "Nenhuma oferta aguardando link."));
  mount("#links-list", h("div", { class: "card" }, table(
    [["Score", (o) => scoreTag(o.dealScore)], ["Oferta", (o) => h("a", { href: o.url, target: "_blank", rel: "noopener noreferrer" }, o.title), "wrap"], ["Marketplace", (o) => MK[o.marketplace]], ["Preço", (o) => brl(o.price)],
     ["Link oficial de afiliado", (o) => { const inp = h("input", { type: "url", placeholder: "https://…", "aria-label": "Link de afiliado" }); return h("div", { class: "actions" }, inp, h("button", { class: "btn small primary", onclick: () => act(`/api/offers/${o.id}/link`, "Link vinculado", renderLinks, { url: inp.value }) }, "Vincular")); }]],
    offers)));
}

async function renderInsights() {
  const i = await api("/api/insights");
  const sec = (title, cols, rows) => h("div", { class: "card" }, h("h2", {}, title), table(cols, rows));
  const perf = [["Chave", (r) => MK[r.key] || r.key], ["Publicações", (r) => int(r.publications)], ["Cliques", (r) => int(r.clicks)], ["Vendas", (r) => int(r.sales)], ["Conversão", (r) => r.conversionRate == null ? "—" : `${r.conversionRate}%`], ["Comissão", (r) => brl(r.commission)]];
  mount("#insights",
    h("p", { class: "hint" }, `Baseado em ${i.sampleSize} publicações registradas. Sem dados suficientes, os pesos ficam neutros — nada é estimado ou inventado.`),
    h("div", { class: "grid2" },
      sec("Categorias por conversão", perf, i.byCategory),
      sec("Marketplaces por receita de comissão", perf, i.byMarketplace),
      sec("Faixas de preço", perf, i.byPriceBand),
      sec("Horários com mais cliques (Brasília)", [["Hora", (r) => `${String((r.hourUtc + 21) % 24).padStart(2, "0")}h`], ["Cliques", (r) => int(r.clicks)]], i.byHour),
      sec("Produtos com mais cliques", [["Produto", (r) => r.key, "wrap"], ["Cliques", (r) => int(r.clicks)], ["Publicações", (r) => r.publications]], i.topProducts),
      sec("Baixo desempenho recorrente", [["Produto", (r) => r.key, "wrap"], ["Publicações", (r) => r.publications]], i.lowPerformers),
      sec("Cupons interessantes", [["Oferta", (r) => r.title, "wrap"], ["Cupom", (r) => r.coupon_code], ["Score", (r) => scoreTag(r.deal_score)]], i.coupons),
      sec("Descontos realmente relevantes", [["Oferta", (r) => r.title, "wrap"], ["Preço", (r) => brl(r.price)], ["Score", (r) => scoreTag(r.deal_score)]], i.strongDiscounts),
      sec("Frequência de publicação", [["Grupo", (r) => r.group], ["Posts/dia", (r) => r.postsPerDay], ["Cliques/post", (r) => r.clicksPerPost]], i.frequency),
      sec("Sazonais / oportunidades de campanha", [["Categoria", (r) => r.category], ["Vendas no mês", (r) => r.thisMonth], ["Média mensal", (r) => r.monthlyAverage]], i.seasonal),
      sec("Pesos aprendidos por categoria", [["Categoria", (r) => r[0]], ["Peso", (r) => r[1]]], Object.entries(i.weights.category))));
}

async function renderFinance() {
  const d = await api("/api/dashboard");
  mount("#finance-summary",
    kpi("Pendentes", brl(d.commissions.pending)), kpi("Aprovadas", brl(d.commissions.approved)),
    kpi("Recebidas", brl(d.commissions.paid), "good"), kpi("Canceladas", brl(d.commissions.cancelled)),
    kpi("Custos", brl(d.costs)), kpi("Resultado operacional", brl(d.operatingResult), d.operatingResult >= 0 ? "good accent" : "bad"),
    kpi("Resultado projetado (rec. + aprov.)", brl(d.projectedResult)));
}

async function renderIntegrations() {
  const [i, agents] = await Promise.all([api("/api/integrations"), api("/api/agents")]);
  mount("#integrations",
    table([["Marketplace", (r) => MK[r.marketplace]], ["Busca", (r) => h("span", { class: "pill " + (r.searchEnabled ? "ok" : "off") }, r.searchEnabled ? "ativa" : "inativa")], ["Link de afiliado", (r) => r.affiliateLinkGeneration === "api" ? "API oficial" : "importação"], ["Situação", (r) => r.note, "wrap"]], i.marketplaces),
    h("h2", {}, "Canais de distribuição"),
    table([["Canal", (r) => r.id], ["Oficial", (r) => r.official ? "sim" : "não"], ["Automático", (r) => r.automatic ? "sim" : "não"], ["Situação", (r) => r.note || (r.id === "telegram_bot" ? (i.telegramConfigured ? "token configurado" : "sem token") : "ativo"), "wrap"]], i.channels));
  mount("#agents", table([["Agente", (r) => r.agent], ["Status", (r) => h("span", { class: "pill " + (r.status === "ok" ? "ok" : r.status === "error" ? "bad" : "off") }, r.status)], ["Última execução", (r) => dt(r.last_run_at)], ["Resultado", (r) => r.last_result, "wrap"]], agents));
  mount("#quotas", table([["Provedor", (r) => r.provider], ["Hora", (r) => `${r.hour.used}/${r.hour.limit}`], ["Dia", (r) => `${r.day.used}/${r.day.limit}`]], i.quotas));
}

const VIEWS = { overview: ["Visão geral", renderOverview], assisted: ["Publicação assistida", renderAssisted], groups: ["Grupos", renderGroups], offers: ["Ofertas", renderOffers], links: ["Aguardando link", renderLinks], insights: ["Inteligência comercial", renderInsights], finance: ["Comissões e custos", renderFinance], integrations: ["Integrações e agentes", renderIntegrations] };
let current = "overview";
async function show(view) {
  current = view;
  document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== view));
  $("#view-title").textContent = VIEWS[view][0];
  try { await VIEWS[view][1](); } catch (e) { toast(e.message, true); }
}

// ---------- Formulários ----------
const csvList = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
$("#group-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = {
    name: f.get("name"), platform: f.get("platform"), inviteLink: f.get("inviteLink") || null, externalId: f.get("externalId") || null,
    admins: csvList(f.get("admins")), categories: csvList(f.get("categories")), marketplaces: f.getAll("marketplaces"),
    audience: f.get("audience") ? Number(f.get("audience")) : null, audienceSource: f.get("audience") ? "informed" : null,
    windowStart: f.get("windowStart"), windowEnd: f.get("windowEnd"), minIntervalMinutes: Number(f.get("minIntervalMinutes")),
    maxDailyPosts: Number(f.get("maxDailyPosts")), minDealScore: Number(f.get("minDealScore")), repostCooldownDays: Number(f.get("repostCooldownDays")),
    affiliateAccount: f.get("affiliateAccount") || null, mode: f.get("mode"), template: f.get("template") || null,
  };
  try { await api("/api/groups", { method: "POST", body }); toast("Grupo cadastrado"); e.target.reset(); renderGroups(); } catch (err) { toast(err.message, true); }
});
async function uploadCsv(input, path, after) {
  const file = $(input).files[0];
  if (!file) return toast("Selecione um arquivo CSV", true);
  try {
    const r = await api(path, { method: "POST", body: { format: "csv", data: await file.text() } });
    toast(`${r.imported} importados${r.errors.length ? `, ${r.errors.length} linhas com erro (ex.: linha ${r.errors[0].row}: ${r.errors[0].error})` : ""}`, r.errors.length > 0 && !r.imported);
    after?.();
  } catch (e) { toast(e.message, true); }
}
$("#import-form").addEventListener("submit", (e) => { e.preventDefault(); uploadCsv("#import-file", "/api/offers/import", renderOffers); });
$("#commission-form").addEventListener("submit", (e) => { e.preventDefault(); uploadCsv("#commission-file", "/api/commissions/import", renderFinance); });
$("#cost-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try { await api("/api/costs", { method: "POST", body: { category: f.get("category"), description: f.get("description"), amount: Number(f.get("amount")) } }); toast("Custo registrado"); e.target.reset(); renderFinance(); } catch (err) { toast(err.message, true); }
});
$("#offer-filter").addEventListener("change", renderOffers);
$("#run-brain").addEventListener("click", async () => {
  try {
    const r = await api("/api/brain/run", { method: "POST", body: {} });
    toast(`Ciclo concluído: ${r.research.found} pesquisadas, ${r.evaluate.approved} aprovadas, ${r.evaluate.awaitingLink} aguardando link, ${r.queue.scheduled} agendadas, ${r.dispatch.ready} prontas para o admin`);
    show(current);
  } catch (e) { toast(e.message, true); }
});
document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

// ---------- Sessão ----------
function logout() {
  token = null;
  try { sessionStorage.removeItem("wedeals.token"); } catch {}
  $("#shell").hidden = true;
  $("#login").hidden = false;
}
$("#logout").addEventListener("click", logout);
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  token = $("#token").value.trim();
  try { await api("/api/dashboard"); try { sessionStorage.setItem("wedeals.token", token); } catch {} start(); }
  catch (err) { $("#login-error").textContent = "Token inválido"; token = null; }
});
async function start() {
  $("#login").hidden = true;
  $("#shell").hidden = false;
  const health = await fetch("/api/health").then((r) => r.json()).catch(() => ({}));
  const flag = $("#publish-flag");
  flag.textContent = health.publishEnabled ? "Publicação real LIBERADA" : "Publicação real desligada";
  flag.className = "pill " + (health.publishEnabled ? "warn" : "ok");
  show("overview");
  setInterval(() => current === "overview" && renderOverview().catch(() => {}), 60_000);
}
if (token) api("/api/dashboard").then(start).catch(logout);
