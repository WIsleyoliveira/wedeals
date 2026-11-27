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
  if (res.status === 401) { logout(false); throw new Error("Sessão expirada"); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.code === "must_change_password") { showPasswordChange(true); throw new Error(data.error); }
  if (res.status === 403 && data.code === "mfa_setup_required") { showMfa(true); throw new Error(data.error); }
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

const ROLE_LABEL = { admin: "Administrador", operador: "Operador" };
const ACTION_LABEL = { "auth.login": "Entrou", "auth.logout": "Saiu", "auth.login_failed": "Senha errada", "auth.denied": "Acesso negado" };
const ROUTE_LABEL = {
  "POST /api/publications/:id/confirm": "Confirmou publicação", "POST /api/publications/:id/skip": "Descartou publicação",
  "POST /api/offers/import": "Importou ofertas", "POST /api/offers/:id/link": "Vinculou link de afiliado", "POST /api/offers/:id/reject": "Rejeitou oferta",
  "POST /api/offers/:id/distribute": "Distribuiu oferta", "POST /api/groups": "Criou grupo", "PATCH /api/groups/:id": "Editou grupo",
  "POST /api/groups/:id/pause": "Pausou grupo", "POST /api/groups/:id/resume": "Retomou grupo", "POST /api/commissions/import": "Importou comissões",
  "POST /api/costs": "Registrou custo", "POST /api/brain/run": "Rodou o ciclo do Mega Brain", "PUT /api/settings/brain": "Alterou configurações do Mega Brain",
  "PUT /api/settings/learning-bounds": "Alterou limites de aprendizado", "POST /api/alerts/test": "Enviou alerta de teste", "POST /api/users": "Criou conta",
  "PATCH /api/users/:id": "Editou conta", "POST /api/users/:id/password": "Redefiniu senha", "POST /api/auth/password": "Trocou a própria senha",
};

function tempPassword() {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(14));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("").replace(/(.{4})(?=.)/g, "$1-");
}
function showTempPassword(user, pw) {
  mount("#users-notice", h("div", { class: "toast" }, `Senha provisória de ${user}: `, h("span", { class: "temp-password" }, pw), " — passe para a pessoa por um canal seguro. Ela troca no primeiro acesso."));
}

async function renderUsers() {
  const users = await api("/api/users");
  const actions = (u) => h("div", { class: "actions" },
    me.id === u.id ? h("span", { class: "pill off" }, "você") : [
      h("button", { class: "btn small", onclick: () => act2(`/api/users/${u.id}`, "PATCH", { role: u.role === "admin" ? "operador" : "admin" }, `Papel de ${u.username} alterado`) }, u.role === "admin" ? "Tornar operador" : "Tornar admin"),
      h("button", { class: "btn small" + (u.active ? " danger" : ""), onclick: () => act2(`/api/users/${u.id}`, "PATCH", { active: !u.active }, u.active ? `${u.username} desativado` : `${u.username} reativado`) }, u.active ? "Desativar" : "Reativar"),
      h("button", { class: "btn small", onclick: async () => { const pw = tempPassword(); if (await act2(`/api/users/${u.id}/password`, "POST", { password: pw }, "Senha redefinida")) showTempPassword(u.username, pw); } }, "Redefinir senha"),
      u.mfaEnabled ? h("button", { class: "btn small", title: "Para quem perdeu o celular e os códigos de recuperação", onclick: () => confirm(`Desligar a verificação em duas etapas de ${u.username}? A pessoa entra só com a senha e precisa ativar de novo.`) && act2(`/api/users/${u.id}/mfa/reset`, "POST", {}, `Verificação em duas etapas de ${u.username} desligada`) }, "Resetar 2 etapas") : null,
    ]);
  mount("#users-list", h("div", { id: "users-notice" }),
    table([["Nome", (u) => u.displayName], ["Usuário", (u) => u.username], ["Papel", (u) => ROLE_LABEL[u.role]],
      ["Situação", (u) => h("span", { class: "pill " + (!u.active ? "off" : u.mustChangePassword ? "warn" : "ok") }, !u.active ? "desativada" : u.mustChangePassword ? "aguardando 1º acesso" : "ativa")],
      ["2 etapas", (u) => h("span", { class: "pill " + (u.mfaEnabled ? "ok" : "off") }, u.mfaEnabled ? "ativa" : "—")],
      ["Último acesso", (u) => dt(u.lastLoginAt)], ["", actions]], users));
  const pol = await api("/api/settings/security");
  $("#policy-admins").checked = pol.requireMfaForAdmins;
  $("#policy-all").checked = pol.requireMfaForAll;
}
async function savePolicy(e) {
  try { await api("/api/settings/security", { method: "PUT", body: { requireMfaForAdmins: $("#policy-admins").checked, requireMfaForAll: $("#policy-all").checked } }); toast("Política de verificação em duas etapas salva"); }
  catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
}
$("#policy-admins").addEventListener("change", savePolicy);
$("#policy-all").addEventListener("change", savePolicy);
async function act2(path, method, body, okMsg) {
  try { await api(path, { method, body }); toast(okMsg); await renderUsers(); return true; }
  catch (e) { toast(e.message, true); return false; }
}

async function renderActivity() {
  const sel = $("#activity-filter");
  if (sel.options.length <= 1) {
    const users = await api("/api/users").catch(() => []);
    for (const u of [...users.map((x) => x.username), "token-admin"]) sel.append(h("option", { value: u }, u === "token-admin" ? "Token de administrador" : u));
  }
  const q = sel.value ? `?actor=${encodeURIComponent(sel.value)}` : "";
  const rows = await api(`/api/activity${q}`);
  const what = (e) => e.action === "api" ? (ROUTE_LABEL[e.detail?.route] || e.detail?.route) + (e.detail?.id ? ` #${e.detail.id}` : "") + (e.detail?.status >= 400 ? ` (recusado: ${e.detail.status})` : "") : ACTION_LABEL[e.action] || e.action;
  mount("#activity-list", table([["Quando", (e) => dt(e.at)], ["Quem", (e) => e.actor === "token-admin" ? "Token de administrador" : e.actor || "sistema"], ["O quê", what, "wrap"]], rows));
}

const ALERT_TYPE = { novo: ["Novo", "bad"], continua: ["Continua", "warn"], resolvido: ["Resolvido", "ok"], falha_envio: ["Falha no envio", "bad"], teste: ["Teste", "off"] };
const SOURCE_LABEL = { monitor: "monitor", backup: "backup", "token-admin": "token de administrador" };

function updateAlertBadge(n) {
  const b = $("#badge-alerts");
  b.textContent = n;
  b.hidden = !n;
}
async function refreshAlertBadge() {
  try { updateAlertBadge((await api("/api/alerts")).active.length); } catch {}
}

function renderAlertsData(a) {
  updateAlertBadge(a.active.length);
  const channels = a.channels.length ? `Avisos enviados por: ${a.channels.map((c) => (c === "telegram" ? "Telegram" : "webhook")).join(" e ")}.` : "Nenhum canal configurado: os alertas só aparecem aqui. Configure Telegram ou webhook no servidor (docs/DEPLOY.md).";
  $("#alerts-meta").textContent = `${channels} Verificação automática a cada 5 minutos${a.lastCheckAt ? `; última em ${dt(a.lastCheckAt)}` : ""}.`;
  $("#alerts-test").disabled = !a.channels.length;
  $("#alerts-test").title = a.channels.length ? "" : "Configure um canal de alerta no servidor primeiro";
  mount("#alerts-active", a.active.length
    ? h("div", { class: "alert-list" }, a.active.map((x) => h("div", { class: "alert-item" },
        h("strong", {}, x.message),
        h("small", {}, `Desde ${dt(x.since)}${x.lastSentAt && a.channels.length ? ` · último aviso ${dt(x.lastSentAt)}` : ""}`))))
    : h("p", { class: "all-clear" }, "Tudo certo: nenhum problema ativo."));
  mount("#alerts-history", table([
    ["Quando", (e) => dt(e.at)],
    ["Tipo", (e) => h("span", { class: "pill " + (ALERT_TYPE[e.type]?.[1] || "off") }, ALERT_TYPE[e.type]?.[0] || e.type)],
    ["O quê", (e) => e.message, "wrap"],
    ["Origem", (e) => SOURCE_LABEL[e.source] || e.source],
    ["Avisado", (e) => (e.type === "falha_envio" ? "—" : e.delivered ? "sim" : a.channels.length ? "não" : "só aqui")],
  ], a.history));
}
async function renderAlerts() { renderAlertsData(await api("/api/alerts")); }
$("#alerts-check").addEventListener("click", async () => {
  try { renderAlertsData(await api("/api/alerts/check", { method: "POST", body: {} })); toast("Verificação concluída"); }
  catch (e) { toast(e.message, true); }
});
$("#alerts-test").addEventListener("click", async () => {
  try { await api("/api/alerts/test", { method: "POST", body: {} }); toast("Alerta de teste enviado"); await renderAlerts(); }
  catch (e) { toast(e.message, true); }
});

const VIEWS = { alerts: ["Alertas", renderAlerts], users: ["Usuários", renderUsers], activity: ["Atividade", renderActivity], overview: ["Visão geral", renderOverview], assisted: ["Publicação assistida", renderAssisted], groups: ["Grupos", renderGroups], offers: ["Ofertas", renderOffers], links: ["Aguardando link", renderLinks], insights: ["Inteligência comercial", renderInsights], finance: ["Comissões e custos", renderFinance], integrations: ["Integrações e agentes", renderIntegrations] };
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
let me = null; // { id, username, displayName, role, mustChangePassword } ou o token de administrador
let refresher = null;

function saveToken(t) { token = t; try { t ? sessionStorage.setItem("wedeals.token", t) : sessionStorage.removeItem("wedeals.token"); } catch {} }

async function logout(callServer = true) {
  if (callServer && token) await fetch("/api/auth/logout", { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
  saveToken(null);
  me = null;
  clearInterval(refresher);
  $("#shell").hidden = true;
  $("#pwchange").hidden = true;
  $("#mfa-screen").hidden = true;
  $("#login").hidden = false;
  backToLogin();
  $("#password").value = "";
  $("#token").value = "";
}
$("#logout").addEventListener("click", () => logout());

let tokenMode = false;
$("#login-mode").addEventListener("click", () => {
  tokenMode = !tokenMode;
  $("#login-user").hidden = tokenMode;
  $("#login-token").hidden = !tokenMode;
  $("#login-mode").textContent = tokenMode ? "Entrar com usuário e senha" : "Entrar com o token de administrador";
  $("#login-error").textContent = "";
});

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#login-error").textContent = "";
  if (tokenMode) {
    saveToken($("#token").value.trim());
    try { await start(); } catch { $("#login-error").textContent = "Token inválido"; saveToken(null); }
    return;
  }
  const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: $("#username").value, password: $("#password").value }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $("#login-error").textContent = data.error || "Não foi possível entrar"; return; }
  $("#password").value = "";
  if (data.mfaRequired) {
    mfaToken = data.mfaToken;
    $("#login-form").hidden = true;
    $("#mfa-login-form").hidden = false;
    $("#mfa-login-error").textContent = "";
    $("#mfa-login-code").value = "";
    $("#mfa-login-code").focus();
    return;
  }
  saveToken(data.token);
  await start();
});

let mfaToken = null;
function backToLogin() {
  mfaToken = null;
  $("#mfa-login-form").hidden = true;
  $("#login-form").hidden = false;
}
$("#mfa-login-back").addEventListener("click", backToLogin);
$("#mfa-login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch("/api/auth/login/mfa", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mfaToken, code: $("#mfa-login-code").value }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.code === "mfa_expired") { backToLogin(); $("#login-error").textContent = data.error; return; }
    $("#mfa-login-error").textContent = data.error || "Código inválido";
    $("#mfa-login-code").select();
    return;
  }
  backToLogin();
  saveToken(data.token);
  await start();
  if (data.recoveryCodesLeft != null) toast(`Você entrou com um código de recuperação. Restam ${data.recoveryCodesLeft}. Gere novos em "Verificação em duas etapas" se estiverem acabando.`, data.recoveryCodesLeft < 3);
});

// ---------- Tela de verificação em duas etapas ----------
let mfaForced = false;
const field = (label, attrs) => h("label", {}, label, h("input", attrs));
function codesBlock(codes) {
  return h("div", { class: "stack" },
    h("p", { class: "hint" }, "Guarde estes códigos de recuperação num lugar seguro (gerenciador de senhas ou papel). Cada um entra uma vez se você perder o celular. Eles não serão mostrados de novo."),
    h("ol", { class: "codes" }, codes.map((c) => h("li", {}, c))),
    h("button", { class: "btn", type: "button", onclick: async () => { await navigator.clipboard.writeText(codes.join("\n")).catch(() => {}); toast("Códigos copiados"); } }, "Copiar códigos"),
    h("button", { class: "btn primary", type: "button", onclick: () => start() }, "Já guardei os códigos"));
}
async function showMfa(forced) {
  mfaForced = forced;
  $("#login").hidden = true;
  $("#shell").hidden = true;
  $("#pwchange").hidden = true;
  $("#mfa-screen").hidden = false;
  $("#mfa-error").textContent = "";
  const r = await fetch("/api/auth/me", { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) return logout(false);
  const info = await r.json();
  me = info.user;
  $("#mfa-who").textContent = `${me.displayName} (${me.username})`;
  $("#mfa-reason").textContent = forced ? "A WAPE exige verificação em duas etapas para a sua conta. Ative para continuar." : "";
  $("#mfa-close").hidden = forced;
  if (!me.mfaEnabled) return mount("#mfa-body", h("div", { class: "stack" },
    h("p", { class: "hint" }, "Além da senha, o login vai pedir um código de 6 dígitos que muda a cada 30 segundos no app autenticador do seu celular (Google Authenticator, Microsoft Authenticator, 1Password…)."),
    h("button", { class: "btn primary", type: "button", onclick: mfaSetup }, "Começar")));
  mount("#mfa-body", h("div", { class: "stack" },
    h("p", { class: "all-clear" }, `Ativa. Códigos de recuperação restantes: ${info.mfa.recoveryCodesLeft}.`),
    h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      try { const r2 = await api("/api/auth/mfa/recovery-codes", { method: "POST", body: { code: e.target.code.value } }); mount("#mfa-body", codesBlock(r2.recoveryCodes)); }
      catch (err) { $("#mfa-error").textContent = err.message; }
    } }, field("Gerar novos códigos de recuperação: código do app", { name: "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "7", required: true }), h("button", { class: "btn", type: "submit" }, "Gerar novos códigos")),
    info.mfa.required ? h("p", { class: "hint" }, "Obrigatória para o seu papel: não pode ser desativada.") :
      h("form", { class: "stack", onsubmit: async (e) => {
        e.preventDefault();
        try { await api("/api/auth/mfa/disable", { method: "POST", body: { password: e.target.password.value, code: e.target.code.value } }); toast("Verificação em duas etapas desativada"); await start(); }
        catch (err) { $("#mfa-error").textContent = err.message; }
      } }, field("Desativar: sua senha", { name: "password", type: "password", autocomplete: "current-password", required: true }),
        field("Código do app ou de recuperação", { name: "code", autocomplete: "one-time-code", maxlength: "20", required: true }),
        h("button", { class: "btn danger", type: "submit" }, "Desativar"))));
}
async function mfaSetup() {
  try {
    const s2 = await api("/api/auth/mfa/setup", { method: "POST", body: {} });
    mount("#mfa-body", h("form", { class: "stack", onsubmit: async (e) => {
      e.preventDefault();
      try { const r2 = await api("/api/auth/mfa/enable", { method: "POST", body: { code: e.target.code.value } }); toast("Verificação em duas etapas ativada"); mount("#mfa-body", codesBlock(r2.recoveryCodes)); $("#mfa-close").hidden = true; }
      catch (err) { $("#mfa-error").textContent = err.message; }
    } },
      h("p", { class: "hint" }, "1. No app autenticador, adicione uma conta e escaneie o QR code:"),
      h("img", { class: "qr", alt: "QR code para o app autenticador", src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s2.qrSvg)}` }),
      h("p", { class: "hint" }, "Ou digite a chave manualmente:"),
      h("p", { class: "secret" }, s2.secret.replace(/(.{4})/g, "$1 ").trim()),
      field("2. Digite o código de 6 dígitos que aparece no app", { name: "code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "7", required: true }),
      h("button", { class: "btn primary", type: "submit" }, "Ativar")));
  } catch (err) { $("#mfa-error").textContent = err.message; }
}
$("#open-mfa").addEventListener("click", () => showMfa(false));
$("#mfa-close").addEventListener("click", () => { $("#mfa-screen").hidden = true; $("#shell").hidden = false; });

function showPasswordChange(required) {
  $("#login").hidden = true;
  $("#shell").hidden = true;
  $("#pwchange").hidden = false;
  $("#pw-who").textContent = me ? `${me.displayName} (${me.username})` : "";
  $("#pw-reason").textContent = required ? "Esta é uma senha provisória. Crie a sua para continuar." : "";
  $("#pw-cancel").hidden = required;
  $("#pw-error").textContent = "";
  $("#pw-current").focus();
}
$("#change-password").addEventListener("click", () => showPasswordChange(false));
$("#pw-cancel").addEventListener("click", () => { $("#pwchange").hidden = true; $("#shell").hidden = false; });
$("#pw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if ($("#pw-new").value !== $("#pw-confirm").value) { $("#pw-error").textContent = "As senhas não conferem"; return; }
  try {
    await api("/api/auth/password", { method: "POST", body: { currentPassword: $("#pw-current").value, newPassword: $("#pw-new").value } });
    e.target.reset();
    toast("Senha alterada. As outras sessões foram encerradas.");
    await start();
  } catch (err) { $("#pw-error").textContent = err.message; }
});

$("#user-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = { displayName: f.get("displayName"), username: String(f.get("username")).trim().toLowerCase(), role: f.get("role"), password: f.get("password") };
  try { await api("/api/users", { method: "POST", body }); toast(`Conta ${body.username} criada`); e.target.reset(); await renderUsers(); showTempPassword(body.username, body.password); }
  catch (err) { toast(err.message, true); }
});
$("#gen-password").addEventListener("click", () => { $("#user-form").elements.password.value = tempPassword(); });
$("#activity-filter").addEventListener("change", renderActivity);

async function start() {
  const r = await fetch("/api/auth/me", { headers: { authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error("não autorizado");
  const meInfo = await r.json();
  me = meInfo.user;
  if (me.mustChangePassword) return showPasswordChange(true);
  if (meInfo.mfa.required && !me.mfaEnabled) return showMfa(true);

  $("#login").hidden = true;
  $("#pwchange").hidden = true;
  $("#mfa-screen").hidden = true;
  $("#shell").hidden = false;
  const isAdmin = me.role === "admin";
  document.querySelectorAll("[data-admin]").forEach((el) => (el.hidden = !isAdmin));
  $("#who-name").textContent = me.displayName;
  $("#who-role").textContent = me.id ? `${me.username} · ${ROLE_LABEL[me.role]}` : "acesso de emergência";
  $("#change-password").hidden = !me.id;
  $("#open-mfa").hidden = !me.id;
  $("#open-mfa").textContent = me.mfaEnabled ? "Verificação em duas etapas (ativa)" : "Ativar verificação em duas etapas";

  const health = await fetch("/api/health").then((r) => r.json()).catch(() => ({}));
  const flag = $("#publish-flag");
  flag.textContent = health.publishEnabled ? "Publicação real LIBERADA" : "Publicação real desligada";
  flag.className = "pill " + (health.publishEnabled ? "warn" : "ok");
  show(VIEWS[current] && (isAdmin || !["users", "activity"].includes(current)) ? current : "overview");
  clearInterval(refresher);
  refreshAlertBadge();
  refresher = setInterval(() => {
    refreshAlertBadge();
    if (current === "overview") renderOverview().catch(() => {});
  }, 60_000);
}
if (token) start().catch(() => logout(false));
