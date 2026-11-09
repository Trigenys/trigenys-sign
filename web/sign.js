// Signing page. States: loading | enroll-remote | enroll-local | received | ready | signing | done.
import { registerServiceWorker } from "./pwa.js";
import { api, bootBrand, esc, fmtDate, notice } from "./common.js";
import { canDrawHere, isCompact, rememberDrawHere } from "./device.js";
import { createKeyPair, fingerprintOf, loadKeyPair, signPayload, supportsEd25519 } from "./keys.js";
import { pop, swapStep } from "./motion.js";
import { SignaturePad, replayStrokes } from "./pad.js";

const $ = (id) => document.getElementById(id);
const token = location.pathname.split("/").pop();
const STEPS = ["enroll-remote", "enroll-local", "received", "ready", "done"];

let ctx = null;
let pad = null;
let keyRecord = null;
let state = "loading";
let changing = false; // "Modifier ma signature": a key already exists, allow going back
let handoff = null; // { id, expiresAt, state }
let received = null; // { id, signaturePng, strokes }
let handoffAbort = null;
let statusAbort = null;
let docRendered = false;

/* ---------- Generic polling: stops when the tab is hidden, resumes when visible ---------- */
function poll(fn, { interval, signal }) {
  let timer = null;
  const tick = async () => {
    if (signal.aborted) return;
    if (document.visibilityState === "hidden") return;
    try {
      const stop = await fn();
      if (stop || signal.aborted) return;
    } catch { /* retried on the next tick */ }
    timer = setTimeout(tick, interval);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible" && !signal.aborted) {
      clearTimeout(timer);
      tick();
    }
  };
  document.addEventListener("visibilitychange", onVisible);
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
  });
  tick();
}

/* ---------- State transitions ---------- */
async function go(next) {
  if (state === next) return;
  const prev = state;
  state = next;
  if (prev === "enroll-remote") stopHandoff();
  if (next === "enroll-local") pad?.clear();
  await swapStep(STEPS.map($), $(next));
  if (next === "enroll-local") pad?.resize();
  if (next === "enroll-remote") startHandoff();
  if (next === "done") stopStatus();
  updateActionbar();
}

function updateActionbar() {
  const bar = $("actionbar");
  if (!isCompact() || state === "loading") return bar.classList.add("hidden");
  bar.classList.remove("hidden");
  const label = { "enroll-remote": "Tracer ma signature", "enroll-local": "Tracer ma signature", received: "Confirmer ma signature", ready: "Signer", done: "Voir le récapitulatif" }[state];
  $("ab-btn").textContent = label || "Continuer";
  $("ab-title").textContent = ctx?.document.title || "";
  $("ab-sub").textContent = state === "done" ? "Document signé" : state === "ready" ? "Votre signature est prête" : "Signature à tracer";
}

function openSheet(open) {
  document.body.classList.toggle("sheet-open", open);
  if (open && state === "enroll-local") requestAnimationFrame(() => pad?.resize());
}

/* ---------- Loading ---------- */
async function load() {
  ctx = await api(`/api/sign/${token}/context`);
  const d = ctx.document;
  const name = ctx.signer.name || ctx.signer.email;
  $("app").classList.remove("hidden");
  $("title").textContent = d.title;
  $("title2").textContent = d.title;
  $("owner").textContent = ctx.owner.name;
  $("sha").textContent = d.sha256;
  setProgress(d.signed, d.total);
  $("who").textContent = name;
  $("signer-name").textContent = name;
  $("done-name").textContent = name;
  $("done-verify").href = `/verify/${d.id}`;
  $("done-pdf").href = `/api/documents/${d.id}/signed.pdf`;
  renderDocument(`/api/documents/${d.id}/original.pdf`);

  if (ctx.signer.signedAt) {
    $("check").classList.add("show");
    $("stamp").classList.add("show");
    $("done-text").textContent = `Vous avez signé ce document le ${fmtDate(ctx.signer.signedAt)}.`;
    await go("done");
    if (ctx.key?.strokes?.length) replayStrokes($("replay"), ctx.key.strokes, { duration: 900 });
    return;
  }

  if (!supportsEd25519()) {
    notice($("error"), "err", "Ce navigateur ne prend pas en charge la génération de clés. Ouvrez ce lien dans Chrome, Edge, Safari ou Firefox à jour.");
    return;
  }

  keyRecord = await loadKeyPair(ctx.signer.email).catch(() => null);
  startStatus();
  if (!ctx.key) return go(canDrawHere() ? "enroll-local" : "enroll-remote");

  $("key-img").src = ctx.key.signaturePng;
  $("key-fp").textContent = ctx.key.fingerprint.slice(0, 16) + "…";
  const localFp = keyRecord ? await fingerprintOf(keyRecord.publicJwk) : null;
  const linked = localFp === ctx.key.fingerprint;
  $("relink").classList.toggle("hidden", linked);
  $("sign-btn").disabled = !linked;
  await go("ready");
}

function setProgress(signed, total) {
  $("progress").textContent = `${signed}/${total} signature${total > 1 ? "s" : ""}`;
}

function renderDocument(url) {
  if (docRendered) return;
  docRendered = true;
  const stage = $("doc-stage");
  import("./pdfview.js")
    .then(({ renderPdf }) => renderPdf(stage, url))
    .catch(() => { /* pdfview shows a link to the file */ });
}

/* ---------- Hand-off to the phone ---------- */
function stopHandoff() {
  handoffAbort?.abort();
  handoffAbort = null;
  handoff = null;
}

function setHandoffStatus(kind, text) {
  const dot = $("ho-dot");
  dot.className = "status-dot" + (kind ? ` ${kind}` : "");
  $("ho-status").textContent = text;
}

async function startHandoff() {
  stopHandoff();
  $("ho-renew").classList.add("hidden");
  $("remote-cancel").classList.toggle("hidden", !changing);
  $("remote-notice").classList.add("hidden");
  $("qr-over").classList.add("hidden");
  $("qr-frame").classList.remove("dim");
  $("ho-countdown").textContent = "";
  setHandoffStatus("", "Préparation du code…");
  let h;
  try {
    h = await api(`/api/sign/${token}/handoff`, { method: "POST", body: {} });
  } catch (err) {
    setHandoffStatus("", "Code indisponible");
    notice($("remote-notice"), "err", esc(err.message));
    $("ho-renew").classList.remove("hidden");
    return;
  }
  if (state !== "enroll-remote") return;
  handoff = { id: h.id, expiresAt: new Date(h.expiresAt).getTime(), state: "waiting" };
  const frame = $("qr-frame");
  frame.querySelector("svg")?.remove();
  frame.insertAdjacentHTML("afterbegin", h.qrSvg);
  setHandoffStatus("live", "En attente de votre téléphone…");

  const ac = new AbortController();
  handoffAbort = ac;
  const countdown = setInterval(() => {
    if (ac.signal.aborted) return clearInterval(countdown);
    const left = Math.max(0, Math.round((handoff.expiresAt - Date.now()) / 1000));
    $("ho-countdown").textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    if (left === 0) expireHandoff("expired");
  }, 1000);
  ac.signal.addEventListener("abort", () => clearInterval(countdown));

  poll(async () => {
    const st = await api(`/api/sign/${token}/handoff/${handoff.id}`);
    if (ac.signal.aborted) return true;
    if (st.state === "claimed" && handoff.state === "waiting") {
      handoff.state = "claimed";
      setHandoffStatus("ok", "Téléphone connecté : tracez votre signature.");
      $("qr-frame").classList.add("dim");
      $("qr-over").textContent = "Téléphone connecté";
      $("qr-over").classList.remove("hidden");
    }
    if (st.state === "submitted") {
      received = { id: handoff.id, signaturePng: st.signaturePng, strokes: st.strokes };
      $("received-img").src = st.signaturePng;
      $("received-notice").classList.add("hidden");
      $("received-use").disabled = false;
      await go("received");
      pop($("received"));
      return true;
    }
    if (st.state === "expired" || st.state === "cancelled" || st.state === "consumed") {
      expireHandoff(st.state);
      return true;
    }
    return false;
  }, { interval: 2000, signal: ac.signal });
}

function expireHandoff(reason) {
  handoffAbort?.abort();
  handoffAbort = null;
  $("qr-frame").classList.add("dim");
  $("qr-over").textContent = reason === "expired" ? "Code expiré" : "Code annulé";
  $("qr-over").classList.remove("hidden");
  setHandoffStatus("", reason === "expired" ? "Ce code a expiré." : "Ce code n'est plus valable.");
  $("ho-countdown").textContent = "";
  $("ho-renew").classList.remove("hidden");
}

/* ---------- Light status polling (signed elsewhere, key changed) ---------- */
function startStatus() {
  stopStatus();
  const ac = new AbortController();
  statusAbort = ac;
  poll(async () => {
    const st = await api(`/api/sign/${token}/status`);
    if (st.signedAt) {
      location.reload();
      return true;
    }
    if (st.keyFingerprint && st.keyFingerprint !== ctx.key?.fingerprint && state === "ready") location.reload();
    return false;
  }, { interval: 6000, signal: ac.signal });
}

function stopStatus() {
  statusAbort?.abort();
  statusAbort = null;
}

/* ---------- Enrolment ---------- */
async function enroll(body, btn, idleLabel, noticeEl) {
  btn.disabled = true;
  btn.textContent = "Création de la clé…";
  try {
    keyRecord = await createKeyPair(ctx.signer.email);
    await api(`/api/sign/${token}/key`, { method: "POST", body: { publicKeyJwk: keyRecord.publicJwk, ...body } });
    changing = false;
    stopStatus();
    await load();
  } catch (err) {
    notice(noticeEl, "err", esc(err.message));
    btn.disabled = false;
    btn.textContent = idleLabel;
    throw err;
  }
}

function setupSegmented() {
  document.querySelectorAll(".segmented button").forEach((b) =>
    b.addEventListener("click", () => {
      const here = b.dataset.mode === "here";
      rememberDrawHere(here);
      go(here ? "enroll-local" : "enroll-remote");
    }),
  );
}

function setupLocal() {
  pad = new SignaturePad($("pad"));
  pad.onChange = (empty) => ($("enroll-save").disabled = empty);
  $("pad-clear").addEventListener("click", () => pad.clear());
  $("enroll-save").addEventListener("click", () =>
    enroll({ signaturePng: pad.toPng(), strokes: pad.serialize() }, $("enroll-save"), "Enregistrer ma signature", $("enroll-notice")).catch(() => {}),
  );
  $("local-cancel").addEventListener("click", () => { changing = false; go("ready"); });
}

function setupRemote() {
  $("ho-renew").addEventListener("click", () => startHandoff());
  $("remote-cancel").addEventListener("click", () => { changing = false; go("ready"); });
  $("received-retry").addEventListener("click", () => { received = null; go("enroll-remote"); });
  $("received-use").addEventListener("click", () =>
    enroll({ handoffId: received.id }, $("received-use"), "Utiliser cette signature", $("received-notice")).catch(() => {}),
  );
}

function setupReady() {
  $("relink-btn").addEventListener("click", () =>
    enroll({ signaturePng: ctx.key.signaturePng, strokes: ctx.key.strokes }, $("relink-btn"), "Associer ce navigateur", $("sign-notice")).catch(() => {}),
  );
  $("change-sig").addEventListener("click", () => {
    changing = true;
    $("local-cancel").classList.remove("hidden");
    go(canDrawHere() ? "enroll-local" : "enroll-remote");
  });
  $("sign-btn").addEventListener("click", async () => {
    const btn = $("sign-btn");
    btn.disabled = true;
    btn.textContent = "Signature en cours…";
    state = "signing";
    stopStatus();
    try {
      const payload = { ...ctx.payload, signedAt: new Date().toISOString() };
      const signature = await signPayload(keyRecord, payload);
      const result = await api(`/api/sign/${token}`, { method: "POST", body: { payload, signature } });
      setProgress(result.total - result.remaining, result.total);
      $("done-text").textContent = result.completed
        ? "Toutes les signatures sont recueillies : le document est complet."
        : `Signature enregistrée. ${result.remaining} signature${result.remaining > 1 ? "s" : ""} encore attendue${result.remaining > 1 ? "s" : ""}.`;
      await go("done");
      await replayStrokes($("replay"), ctx.key.strokes);
      $("check").classList.add("show");
      $("stamp").classList.add("show");
    } catch (err) {
      state = "ready";
      startStatus();
      notice($("sign-notice"), "err", esc(err.message));
      btn.disabled = false;
      btn.textContent = "Signer le document";
    }
  });
}

function setupSheet() {
  $("ab-btn").addEventListener("click", () => openSheet(true));
  $("sheet-backdrop").addEventListener("click", () => openSheet(false));
  document.addEventListener("keydown", (e) => e.key === "Escape" && openSheet(false));
  let wasCompact = isCompact();
  window.addEventListener("resize", () => {
    const compact = isCompact();
    if (compact !== wasCompact) {
      wasCompact = compact;
      if (!compact) openSheet(false);
      updateActionbar();
    }
  });
}

/* ---------- Segmented controls: hide the "phone" option on touch-only devices ---------- */
function tuneForDevice() {
  const localSeg = $("enroll-local").querySelector(".segmented");
  localSeg.classList.toggle("hidden", window.matchMedia("(pointer: coarse)").matches);
  if (window.matchMedia("(pointer: coarse)").matches) $("local-lead").textContent = "Tracez votre signature au doigt. Une clé personnelle est créée dans ce navigateur et ne le quitte jamais.";
}

setupSegmented();
setupLocal();
setupRemote();
setupReady();
setupSheet();
tuneForDevice();
registerServiceWorker();
bootBrand();
load().catch((err) => notice($("error"), err.status === 410 ? "warn" : "err", err.status === 410 ? `${esc(err.message)}. Ce lien ne permet plus de signer ; si une nouvelle version est émise, vous recevrez un nouveau lien.` : esc(err.message)));
