import { api, bootBrand, esc, fmtDate, notice } from "./common.js";

const $ = (id) => document.getElementById(id);
const sections = ["login", "dash", "create", "detail"];
let me = null;
let docs = [];

function show(name) {
  for (const s of sections) $(s).classList.toggle("hidden", s !== name);
}

function initials(m) {
  const base = (m.name || "").trim() || m.email.split("@")[0].replace(/[._-]+/g, " ");
  const parts = base.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

function closeAccount() {
  $("account")?.classList.remove("open");
  $("account-btn")?.setAttribute("aria-expanded", "false");
}

async function refreshMe() {
  me = await api("/api/me");
  $("who").innerHTML = me
    ? `<div class="account" id="account">
        <button type="button" class="account-btn" id="account-btn" aria-haspopup="menu" aria-expanded="false" title="${esc(me.email)}">
          <span class="avatar" aria-hidden="true">${esc(initials(me))}</span>
          <span class="account-name">${esc(me.name || me.email.split("@")[0])}</span>
          <svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="account-menu" role="menu">
          <div class="account-id"><strong>${esc(me.name || "Sans nom")}</strong><span>${esc(me.email)}</span></div>
          <a href="#" role="menuitem">Mes documents</a>
          <a href="#new" role="menuitem">Nouveau document</a>
          <button type="button" role="menuitem" id="logout">Déconnexion</button>
        </div>
      </div>`
    : "";
  $("account-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = $("account").classList.toggle("open");
    $("account-btn").setAttribute("aria-expanded", String(open));
  });
  $("account")?.querySelectorAll("[role=menuitem]").forEach((el) => el.addEventListener("click", closeAccount));
  $("logout")?.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST", body: {} });
    location.hash = "";
    await boot();
  });
  return me;
}
document.addEventListener("click", (e) => {
  if (!e.target.closest("#account")) closeAccount();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAccount();
});

// ---- Phone fields (flag + dial code dropdown, E.164 output)
const PHONE_OPTS = {
  initialCountry: "cm",
  countryOrder: ["cm", "fr", "ci", "sn", "ga", "cd", "cg", "td", "bj", "tg", "ma", "be", "ch", "ca", "us"],
  separateDialCode: true,
  strictMode: true,
  autoPlaceholder: "aggressive",
  i18n: { searchPlaceholder: "Rechercher un pays" },
};
const phoneI18n = import("https://cdn.jsdelivr.net/npm/intl-tel-input@25.11.2/build/js/i18n/fr/index.js")
  .then((m) => Object.assign(PHONE_OPTS.i18n, m.default))
  .catch(() => {});
const phones = new WeakMap();
function phoneField(input, value = "") {
  if (!window.intlTelInput) return null;
  const iti = window.intlTelInput(input, PHONE_OPTS);
  if (value) iti.setNumber(value);
  phones.set(input, iti);
  const check = () => {
    const bad = input.value.trim() !== "" && !iti.isValidNumber();
    input.classList.toggle("is-invalid", bad);
  };
  input.addEventListener("blur", check);
  input.addEventListener("countrychange", check);
  input.addEventListener("input", () => input.classList.remove("is-invalid"));
  return iti;
}
function phoneValue(input) {
  const iti = phones.get(input);
  if (!iti) return input.value.trim() || null;
  if (input.value.trim() === "") return null;
  if (!iti.isValidNumber()) throw new Error(`Numéro WhatsApp invalide (${iti.getNumber() || input.value.trim()})`);
  return iti.getNumber();
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
    me = await api("/api/me", { method: "POST", body: { name: $("p-name").value.trim(), phone: phoneValue($("p-phone")) } });
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
    <div><label>WhatsApp (optionnel)</label><input type="tel" name="phone" autocomplete="off"></div>
    <button type="button" class="remove" title="Retirer">✕</button>`;
  row.querySelector(".remove").addEventListener("click", () => {
    if ($("signer-rows").children.length > 1) row.remove();
  });
  $("signer-rows").appendChild(row);
  phoneField(row.querySelector("[name=phone]"), values.phone || "");
}
$("add-signer").addEventListener("click", () => signerRow());

// ---- PDF dropzone
let pickedFile = null;
const dz = $("dropzone");
function fmtSize(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}
async function isPdf(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    const head = await file.slice(0, 5).text();
    return head === "%PDF-";
  }
  return false;
}
async function setFile(file) {
  if (!file) {
    pickedFile = null;
    $("c-file").value = "";
    dz.classList.remove("has-file", "error");
    dz.querySelector(".dz-empty").classList.remove("hidden");
    dz.querySelector(".dz-file").classList.add("hidden");
    return;
  }
  if (!(await isPdf(file))) {
    dz.classList.add("error");
    notice($("create-notice"), "err", `« ${esc(file.name)} » n'est pas un PDF. Convertissez le document en PDF avant de l'importer.`);
    return;
  }
  pickedFile = file;
  dz.classList.remove("error");
  dz.classList.add("has-file");
  $("create-notice").classList.add("hidden");
  dz.querySelector(".dz-name").textContent = file.name;
  dz.querySelector(".dz-size").textContent = `${fmtSize(file.size)} · modifié le ${fmtDate(file.lastModified)}`;
  dz.querySelector(".dz-empty").classList.add("hidden");
  dz.querySelector(".dz-file").classList.remove("hidden");
  if (!$("c-title").value.trim()) $("c-title").value = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");
}
dz.addEventListener("click", (e) => {
  if (e.target.closest(".dz-actions")) return;
  $("c-file").click();
});
dz.addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target === dz) {
    e.preventDefault();
    $("c-file").click();
  }
});
$("c-file").addEventListener("change", () => setFile($("c-file").files[0]));
$("dz-replace").addEventListener("click", () => $("c-file").click());
$("dz-remove").addEventListener("click", () => setFile(null));
for (const ev of ["dragenter", "dragover"]) {
  dz.addEventListener(ev, (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dz.classList.add("dragging");
  });
}
dz.addEventListener("dragleave", (e) => {
  if (!dz.contains(e.relatedTarget)) dz.classList.remove("dragging");
});
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  dz.classList.remove("dragging");
  const file = e.dataTransfer.files?.[0];
  if (file) setFile(file);
});

$("create-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const file = pickedFile;
  if (!file) {
    dz.classList.add("error");
    dz.focus();
    return notice($("create-notice"), "err", "Ajoutez le PDF à faire signer.");
  }
  let signers;
  try {
    signers = [...$("signer-rows").querySelectorAll(".signer-row")].map((r) => ({
      name: r.querySelector("[name=name]").value.trim(),
      email: r.querySelector("[name=email]").value.trim(),
      phone: phoneValue(r.querySelector("[name=phone]")) || undefined,
    }));
  } catch (err) {
    return notice($("create-notice"), "err", esc(err.message));
  }
  const meta = btoa(unescape(encodeURIComponent(JSON.stringify({ title: $("c-title").value.trim(), signers }))));
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const doc = await api("/api/documents", { method: "POST", raw: true, body: file, headers: { "content-type": "application/pdf", "x-document-meta": meta } });
    $("create-form").reset();
    await setFile(null);
    $("signer-rows").innerHTML = "";
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

let profilePhone = null;
async function boot() {
  await phoneI18n;
  await refreshMe();
  if (me) {
    $("p-name").value = me.name || "";
    if (!profilePhone) profilePhone = phoneField($("p-phone"));
    if (profilePhone) profilePhone.setNumber(me.phone || "");
    else $("p-phone").value = me.phone || "";
  }
  await route();
}

window.addEventListener("hashchange", route);
bootBrand();
boot();
