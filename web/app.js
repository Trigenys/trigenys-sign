import { api, bootBrand, esc, fmtDate, notice } from "./common.js";
import { clearDraft, debounce, hasContent, loadDraft, saveDraft } from "./draft.js";
import { FieldPlacer, renderLegend } from "./fields.js";

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
// Signer book: people this account already sent documents to. Loaded once per form opening; filtered client-side.
let contacts = [];
let contactsLoaded = null;
function loadContacts() {
  contactsLoaded ??= api("/api/contacts").then((list) => (contacts = list)).catch(() => (contacts = []));
  return contactsLoaded;
}
function matchContacts(q) {
  const n = q.trim().toLowerCase();
  const hits = n ? contacts.filter((c) => (c.name || "").toLowerCase().includes(n) || c.email.toLowerCase().includes(n)) : contacts;
  return hits.slice(0, 6);
}
function fillRow(row, c) {
  row.querySelector("[name=name]").value = c.name || "";
  row.querySelector("[name=email]").value = c.email;
  const tel = row.querySelector("[name=phone]");
  const iti = phones.get(tel);
  if (iti) iti.setNumber(c.phone || "");
  else tel.value = c.phone || "";
  tel.classList.remove("is-invalid");
}
function combobox(input, row) {
  const wrap = input.parentElement;
  wrap.classList.add("combo");
  const list = document.createElement("ul");
  list.className = "combo-list";
  list.setAttribute("role", "listbox");
  wrap.appendChild(list);
  input.setAttribute("autocomplete", "off");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "false");
  let items = [];
  let active = -1;
  const close = () => { list.innerHTML = ""; wrap.classList.remove("open"); input.setAttribute("aria-expanded", "false"); active = -1; };
  const paint = () => [...list.children].forEach((li, i) => li.classList.toggle("active", i === active));
  const open = () => {
    items = matchContacts(input.value);
    if (!items.length) return close();
    list.innerHTML = items.map((c) => `<li role="option"><strong>${esc(c.name || c.email)}</strong><span>${esc(c.email)}${c.phone ? " · WhatsApp" : ""}</span></li>`).join("");
    [...list.children].forEach((li, i) => {
      li.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus so blur does not close first
      li.addEventListener("click", () => { fillRow(row, items[i]); close(); row.querySelector("[name=email]").blur(); });
    });
    wrap.classList.add("open");
    input.setAttribute("aria-expanded", "true");
    active = -1;
  };
  input.addEventListener("focus", () => loadContacts().then(() => document.activeElement === input && open()));
  input.addEventListener("input", open);
  input.addEventListener("blur", close);
  input.addEventListener("keydown", (e) => {
    if (!wrap.classList.contains("open")) { if (e.key === "ArrowDown") open(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); fillRow(row, items[active]); close(); }
    else if (e.key === "Escape") close();
  });
}
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
    syncPlacerSigners();
    queueDraft();
  });
  row.dataset.key = String(++rowSeq);
  if (values.field) pendingFields[row.dataset.key] = values.field;
  $("signer-rows").appendChild(row);
  row.querySelector("[name=name]").addEventListener("input", syncPlacerSigners);
  phoneField(row.querySelector("[name=phone]"), values.phone || "");
  combobox(row.querySelector("[name=name]"), row);
  combobox(row.querySelector("[name=email]"), row);
  row.querySelector("[name=phone]").addEventListener("countrychange", queueDraft);
}
$("add-signer").addEventListener("click", () => { signerRow(); syncPlacerSigners(); queueDraft(); });

// ---- Signature placement on the PDF (create form)
let rowSeq = 0;
let pendingFields = {}; // row key -> field, applied once the PDF is rendered (draft restore)
let placer = null;
let placerFile = null; // the File currently rendered
function rowSigners() {
  return [...$("signer-rows").querySelectorAll(".signer-row")].map((r) => ({ key: r.dataset.key, name: r.querySelector("[name=name]").value.trim() }));
}
function syncPlacerSigners() {
  if (!placer || placerFile !== pickedFile) return;
  placer.setSigners(rowSigners());
  renderLegend($("fields-legend"), placer);
  updateFieldsHint();
}
function updateFieldsHint() {
  if (!placer) return;
  const fields = placer.getFields();
  const missing = placer.signers.filter((s) => !fields[s.key]).length;
  $("fields-hint").textContent = placer.armed
    ? "Cliquez sur la page à l'endroit où la signature doit apparaître."
    : missing === 0
      ? "Chaque signature sera incrustée à l'emplacement indiqué. La feuille de signatures reste annexée au PDF final."
      : `${missing} signataire${missing > 1 ? "s" : ""} sans emplacement : sa signature n'apparaîtra que sur la feuille annexée. Cliquez sur son nom, puis sur la page, pour la placer.`;
}
async function syncPlacerFile() {
  const wrap = $("fields-wrap");
  if (!pickedFile) {
    wrap.classList.add("hidden");
    placerFile = null;
    if (placer) placer.setFields({});
    return;
  }
  if (!placer) {
    placer = new FieldPlacer($("fields-stage"), {
      onChange: () => { renderLegend($("fields-legend"), placer); updateFieldsHint(); if (placerFile === pickedFile) queueDraft(); },
    });
    $("fields-suggest").addEventListener("click", async () => {
      const n = await placer.suggest();
      if (!n) notice($("create-notice"), "info", "Aucune mention « Signature » trouvée dans le texte du PDF : placez les zones à la main.");
    });
  }
  if (placerFile === pickedFile) return;
  const file = pickedFile;
  placerFile = file;
  const keep = placer.getFields();
  wrap.classList.remove("hidden");
  try {
    await placer.load({ data: await file.arrayBuffer() });
  } catch {
    if (placerFile === file) wrap.classList.add("hidden");
    return;
  }
  if (placerFile !== file) return;
  placer.setSigners(rowSigners());
  const restored = Object.keys(pendingFields).length ? pendingFields : keep;
  pendingFields = {};
  placer.setFields(restored);
  if (!Object.values(placer.getFields()).some(Boolean)) await placer.suggest();
  renderLegend($("fields-legend"), placer);
  updateFieldsHint();
  queueDraft();
}

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
    dz.dispatchEvent(new Event("setfile"));
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
  dz.dispatchEvent(new Event("setfile"));
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

// ---- Draft (per account, in this browser)
let restoring = false;
function readForm() {
  return {
    title: $("c-title").value,
    signers: [...$("signer-rows").querySelectorAll(".signer-row")].map((r) => {
      const tel = r.querySelector("[name=phone]");
      const iti = phones.get(tel);
      const field = placer && placerFile === pickedFile ? placer.getFields()[r.dataset.key] || null : pendingFields[r.dataset.key] || null;
      return { name: r.querySelector("[name=name]").value, email: r.querySelector("[name=email]").value, phone: (iti ? iti.getNumber() : tel.value) || "", field };
    }),
    file: pickedFile,
    fileName: pickedFile?.name || null,
    lastModified: pickedFile?.lastModified || null,
  };
}
async function persistDraft() {
  if (restoring || !me || location.hash.slice(1) !== "new") return;
  const d = readForm();
  if (hasContent(d)) {
    await saveDraft(me.email, d);
    showDraftNote(Date.now());
  } else {
    await clearDraft(me.email);
    showDraftNote(null);
  }
}
const queueDraft = debounce(persistDraft, 400);
$("create-form").addEventListener("input", queueDraft);
function showDraftNote(savedAt) {
  const el = $("draft-note");
  el.classList.toggle("hidden", !savedAt);
  if (savedAt) $("draft-time").textContent = new Date(savedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
async function restoreDraft() {
  const d = await loadDraft(me.email);
  if (!hasContent(d)) return false;
  restoring = true;
  try {
    $("c-title").value = d.title || "";
    $("signer-rows").innerHTML = "";
    for (const sg of d.signers?.length ? d.signers : [{}]) signerRow(sg);
    if (d.file) await setFile(new File([d.file], d.fileName || "document.pdf", { type: "application/pdf", lastModified: d.lastModified || Date.now() }));
    showDraftNote(d.savedAt);
  } finally {
    restoring = false;
  }
  return true;
}
async function resetCreateForm() {
  $("create-form").reset();
  pendingFields = {};
  await setFile(null);
  $("signer-rows").innerHTML = "";
  signerRow();
  showDraftNote(null);
}
$("draft-clear").addEventListener("click", async () => {
  await clearDraft(me.email);
  await resetCreateForm();
});
$("dz-replace").addEventListener("click", () => $("c-file").click());
$("dz-remove").addEventListener("click", () => setFile(null));
dz.addEventListener("setfile", queueDraft);
dz.addEventListener("setfile", () => { syncPlacerFile(); });
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
      field: placer && placerFile === pickedFile ? placer.getFields()[r.dataset.key] || null : null,
    }));
  } catch (err) {
    return notice($("create-notice"), "err", esc(err.message));
  }
  const meta = btoa(unescape(encodeURIComponent(JSON.stringify({ title: $("c-title").value.trim(), signers }))));
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const doc = await api("/api/documents", { method: "POST", raw: true, body: file, headers: { "content-type": "application/pdf", "x-document-meta": meta } });
    await clearDraft(me.email);
    await resetCreateForm();
    $("signer-rows").innerHTML = "";
    contactsLoaded = null;
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
  renderDetailFields(d);
  $("detail-signed").href = `/api/documents/${d.id}/signed.pdf`;
  $("detail-signed").classList.toggle("hidden", d.signed === 0);
  $("detail-verify").href = `/verify/${d.id}`;
}

// ---- Detail: where each signature lands (editable until the first signature)
let detailPlacer = null;
let detailPlacerDoc = null;
function renderDetailFields(d) {
  const wrap = $("d-fields");
  const placed = d.signers.filter((s) => s.field).length;
  $("d-fields-summary").textContent = placed === 0
    ? "Les signatures apparaissent uniquement sur la feuille de signatures annexée au PDF final."
    : placed === d.signers.length
      ? "Chaque signature est incrustée dans le document à l'emplacement prévu, en plus de la feuille annexée."
      : `${placed} signature${placed > 1 ? "s" : ""} sur ${d.signers.length} incrustée${placed > 1 ? "s" : ""} dans le document ; les autres n'apparaissent que sur la feuille annexée.`;
  const pending = d.signers.filter((s) => !s.signedAt);
  const editable = pending.length > 0;
  const editBtn = $("d-fields-edit");
  editBtn.textContent = placed ? "Modifier les emplacements" : "Placer les signatures";
  const lockedNote = d.signed > 0 && editable ? " Les signataires ayant déjà signé n’apparaissent que sur la feuille annexée." : "";
  $("d-fields-summary").textContent += lockedNote;
  editBtn.classList.toggle("hidden", !editable);
  $("d-fields-editor").classList.add("hidden");
  $("d-fields-notice").classList.add("hidden");
  editBtn.onclick = async () => {
    $("d-fields-editor").classList.remove("hidden");
    editBtn.classList.add("hidden");
    if (!detailPlacer) {
      detailPlacer = new FieldPlacer($("d-fields-stage"), { onChange: () => { renderLegend($("d-fields-legend"), detailPlacer); $("d-fields-save").disabled = false; } });
      $("d-fields-suggest").addEventListener("click", () => detailPlacer.suggest());
    }
    if (detailPlacerDoc !== d.id) {
      detailPlacerDoc = d.id;
      await detailPlacer.load({ url: `/api/documents/${d.id}/original.pdf` });
    }
    // Signed signers are locked server side (409): only the pending ones are placeable.
    detailPlacer.setSigners(pending.map((s) => ({ key: s.id, name: s.name || s.email })));
    detailPlacer.setFields(Object.fromEntries(pending.map((s) => [s.id, s.field])));
    renderLegend($("d-fields-legend"), detailPlacer);
    $("d-fields-save").disabled = true;
  };
  $("d-fields-save").onclick = async () => {
    try {
      const next = await api(`/api/documents/${d.id}/fields`, { method: "PUT", body: { fields: detailPlacer.getFields() } });
      renderDetailFields(next);
      notice($("d-fields-notice"), "ok", "Emplacements enregistrés.");
    } catch (err) {
      notice($("d-fields-notice"), "err", esc(err.message));
    }
  };
  $("d-fields-cancel").onclick = () => renderDetailFields(d);
  wrap.classList.remove("hidden");
}

// ---- Router
async function route() {
  if (!me) return show("login");
  const h = location.hash.slice(1);
  if (h === "new") {
    if (!$("signer-rows").children.length && !(await restoreDraft())) signerRow();
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
