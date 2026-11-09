import { api, bootBrand, esc, fmtDate, notice } from "./common.js";

const $ = (id) => document.getElementById(id);
const sections = ["login", "dash", "create", "detail"];
let me = null;
let docs = [];

function show(name) {
  for (const s of sections) $(s).classList.toggle("hidden", s !== name);
}

async function refreshMe() {
  me = await api("/api/me");
  $("who").innerHTML = me ? `<span>${esc(me.name || me.email)}</span><button id="logout">Déconnexion</button>` : "";
  $("logout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST", body: {} });
    location.hash = "";
    await boot();
  });
  return me;
}

// ---- Login
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("login-email").value.trim();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const r = await api("/api/auth/request", { method: "POST", body: { email } });
    const dev = r.link ? `<br><small>Mode développement : <a href="${esc(r.link)}">ouvrir le lien</a></small>` : "";
    notice($("login-notice"), "ok", `Lien envoyé à <strong>${esc(email)}</strong>. Vérifiez votre boîte mail (et vos spams).${dev}`);
  } catch (err) {
    notice($("login-notice"), "err", esc(err.message));
  } finally {
    btn.disabled = false;
  }
});

// ---- Dashboard
async function loadDocs() {
  docs = await api("/api/documents");
  const list = $("doc-list");
  list.innerHTML = docs
    .map((d) => {
      const pct = d.total ? Math.round((d.signed / d.total) * 100) : 0;
      const pill = d.status === "completed" ? '<span class="pill ok">Complet</span>' : `<span class="pill pending">${d.remaining} manquante${d.remaining > 1 ? "s" : ""}</span>`;
      return `<article class="doc-item" data-id="${d.id}">
        <div><h3>${esc(d.title)}</h3><small class="muted">Créé le ${fmtDate(d.createdAt)} · ${d.total} signataire${d.total > 1 ? "s" : ""}</small>
        <div class="progress"><span style="width:${pct}%"></span></div></div>
        <div style="text-align:right"><div class="counter">${d.signed}/${d.total}</div>${pill}</div>
      </article>`;
    })
    .join("");
  $("doc-empty").classList.toggle("hidden", docs.length > 0);
  list.querySelectorAll(".doc-item").forEach((el) => el.addEventListener("click", () => (location.hash = `doc=${el.dataset.id}`)));
}

$("new-doc").addEventListener("click", () => (location.hash = "new"));
$("create-cancel").addEventListener("click", () => (location.hash = ""));
$("detail-back").addEventListener("click", () => (location.hash = ""));

// ---- Profile
$("profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    me = await api("/api/me", { method: "POST", body: { name: $("p-name").value.trim(), phone: $("p-phone").value.trim() || null } });
    $("profile-saved").classList.remove("hidden");
    setTimeout(() => $("profile-saved").classList.add("hidden"), 2000);
    await refreshMe();
  } catch (err) {
    alert(err.message);
  }
});

// ---- Create
function signerRow(values = {}) {
  const row = document.createElement("div");
  row.className = "signer-row";
  row.innerHTML = `
    <div><label>Nom</label><input type="text" name="name" required placeholder="Nom Prénom" value="${esc(values.name)}"></div>
    <div><label>E-mail</label><input type="email" name="email" required placeholder="nom@trigenys.com" value="${esc(values.email)}"></div>
    <div><label>WhatsApp (optionnel)</label><input type="tel" name="phone" placeholder="+237..." value="${esc(values.phone)}"></div>
    <button type="button" class="remove" title="Retirer">✕</button>`;
  row.querySelector(".remove").addEventListener("click", () => {
    if ($("signer-rows").children.length > 1) row.remove();
  });
  $("signer-rows").appendChild(row);
}
$("add-signer").addEventListener("click", () => signerRow());

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = $("c-file").files[0];
  const signers = [...$("signer-rows").querySelectorAll(".signer-row")].map((r) => ({
    name: r.querySelector('[name=name]').value.trim(),
    email: r.querySelector('[name=email]').value.trim(),
    phone: r.querySelector('[name=phone]').value.trim() || undefined,
  }));
  const meta = btoa(unescape(encodeURIComponent(JSON.stringify({ title: $("c-title").value.trim(), signers }))));
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const doc = await api("/api/documents", { method: "POST", raw: true, body: file, headers: { "content-type": "application/pdf", "x-document-meta": meta } });
    $("create-form").reset();
    location.hash = `doc=${doc.id}`;
  } catch (err) {
    notice($("create-notice"), "err", esc(err.message));
  } finally {
    btn.disabled = false;
  }
});

// ---- Detail
async function loadDetail(id) {
  const d = await api(`/api/documents/${id}`);
  $("d-title").textContent = d.title;
  $("d-sha").textContent = d.sha256;
  $("d-signed").textContent = d.signed;
  $("d-total").textContent = d.total;
  $("d-bar").style.width = d.total ? `${Math.round((d.signed / d.total) * 100)}%` : "0%";
  const st = $("d-status");
  st.className = `pill ${d.status === "completed" ? "ok" : "pending"}`;
  st.textContent = d.status === "completed" ? `Complet · ${fmtDate(d.completedAt)}` : `${d.remaining} signature${d.remaining > 1 ? "s" : ""} manquante${d.remaining > 1 ? "s" : ""}`;
  $("d-signers").innerHTML = d.signers
    .map(
      (s) => `<li><div><div class="name">${esc(s.name || s.email)}</div><div class="mail">${esc(s.email)}${s.hasPhone ? " · WhatsApp" : ""}</div></div>
        ${s.signedAt ? `<span class="pill ok">Signé · ${fmtDate(s.signedAt)}</span>` : '<span class="pill pending">En attente</span>'}</li>`,
    )
    .join("");
  $("detail-original").href = `/api/documents/${d.id}/original.pdf`;
  $("detail-signed").href = `/api/documents/${d.id}/signed.pdf`;
  $("detail-signed").classList.toggle("hidden", d.signed === 0);
  $("detail-verify").href = `/verify/${d.id}`;
}

// ---- Router
async function route() {
  if (!me) return show("login");
  const h = location.hash.slice(1);
  if (h === "new") {
    if (!$("signer-rows").children.length) signerRow();
    return show("create");
  }
  if (h.startsWith("doc=")) {
    try {
      await loadDetail(h.slice(4));
      return show("detail");
    } catch (err) {
      alert(err.message);
      location.hash = "";
      return;
    }
  }
  await loadDocs();
  show("dash");
}

async function boot() {
  await refreshMe();
  if (me) {
    $("p-name").value = me.name || "";
    $("p-phone").value = me.phone || "";
  }
  await route();
}

window.addEventListener("hashchange", route);
bootBrand();
boot();
