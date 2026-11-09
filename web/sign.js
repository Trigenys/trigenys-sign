import { api, bootBrand, esc, fmtDate, notice } from "./common.js";
import { createKeyPair, fingerprintOf, loadKeyPair, signPayload, supportsEd25519 } from "./keys.js";
import { SignaturePad, replayStrokes } from "./pad.js";

const $ = (id) => document.getElementById(id);
const token = location.pathname.split("/").pop();
let ctx = null;
let pad = null;
let keyRecord = null;

function showCard(name) {
  for (const c of ["enroll", "ready", "done"]) $(c).classList.toggle("hidden", c !== name);
}

async function load() {
  ctx = await api(`/api/sign/${token}/context`);
  const d = ctx.document;
  $("app").classList.remove("hidden");
  $("title").textContent = d.title;
  $("title2").textContent = d.title;
  $("owner").textContent = ctx.owner.name;
  $("sha").textContent = d.sha256;
  $("progress").textContent = `${d.signed}/${d.total} signature${d.total > 1 ? "s" : ""}`;
  $("pdf").src = `/api/documents/${d.id}/original.pdf#toolbar=0`;
  $("who").textContent = `${ctx.signer.name || ctx.signer.email}`;
  $("signer-name").textContent = ctx.signer.name || ctx.signer.email;
  $("done-name").textContent = ctx.signer.name || ctx.signer.email;
  $("done-verify").href = `/verify/${d.id}`;
  $("done-pdf").href = `/api/documents/${d.id}/signed.pdf`;

  if (ctx.signer.signedAt) {
    $("check").classList.add("show");
    $("stamp").classList.add("show");
    $("done-text").textContent = `Vous avez signé ce document le ${fmtDate(ctx.signer.signedAt)}.`;
    if (ctx.key?.strokes?.length) replayStrokes($("replay"), ctx.key.strokes, { duration: 900 });
    return showCard("done");
  }

  if (!supportsEd25519()) {
    notice($("error"), "err", "Ce navigateur ne prend pas en charge la génération de clés. Ouvrez ce lien dans Chrome, Edge, Safari ou Firefox à jour.");
    return;
  }

  keyRecord = await loadKeyPair(ctx.signer.email).catch(() => null);
  if (!ctx.key) return setupEnroll();

  $("key-img").src = ctx.key.signaturePng;
  $("key-fp").textContent = ctx.key.fingerprint.slice(0, 16) + "…";
  const localFp = keyRecord ? await fingerprintOf(keyRecord.publicJwk) : null;
  const linked = localFp === ctx.key.fingerprint;
  $("relink").classList.toggle("hidden", linked);
  $("sign-btn").disabled = !linked;
  showCard("ready");
}

function setupEnroll() {
  showCard("enroll");
  pad = new SignaturePad($("pad"));
  pad.onChange = (empty) => ($("enroll-save").disabled = empty);
  $("pad-clear").addEventListener("click", () => pad.clear());
  $("enroll-save").addEventListener("click", async () => {
    const btn = $("enroll-save");
    btn.disabled = true;
    btn.textContent = "Génération de la clé…";
    try {
      keyRecord = await createKeyPair(ctx.signer.email);
      await api(`/api/sign/${token}/key`, {
        method: "POST",
        body: { publicKeyJwk: keyRecord.publicJwk, signaturePng: pad.toPng(), strokes: pad.serialize() },
      });
      await load();
    } catch (err) {
      notice($("enroll-notice"), "err", esc(err.message));
      btn.disabled = false;
      btn.textContent = "Enregistrer ma signature";
    }
  });
}

$("relink-btn").addEventListener("click", async () => {
  const btn = $("relink-btn");
  btn.disabled = true;
  try {
    keyRecord = await createKeyPair(ctx.signer.email);
    await api(`/api/sign/${token}/key`, {
      method: "POST",
      body: { publicKeyJwk: keyRecord.publicJwk, signaturePng: ctx.key.signaturePng, strokes: ctx.key.strokes },
    });
    await load();
  } catch (err) {
    notice($("sign-notice"), "err", esc(err.message));
    btn.disabled = false;
  }
});

$("sign-btn").addEventListener("click", async () => {
  const btn = $("sign-btn");
  btn.disabled = true;
  btn.textContent = "Signature en cours…";
  try {
    const payload = { ...ctx.payload, signedAt: new Date().toISOString() };
    const signature = await signPayload(keyRecord, payload);
    const result = await api(`/api/sign/${token}`, { method: "POST", body: { payload, signature } });
    $("progress").textContent = `${result.total - result.remaining}/${result.total} signature${result.total > 1 ? "s" : ""}`;
    showCard("done");
    await replayStrokes($("replay"), ctx.key.strokes);
    $("check").classList.add("show");
    $("stamp").classList.add("show");
    $("done-text").textContent = result.completed
      ? "Toutes les signatures sont recueillies : le document est complet."
      : `Signature enregistrée. ${result.remaining} signature${result.remaining > 1 ? "s" : ""} encore attendue${result.remaining > 1 ? "s" : ""}.`;
  } catch (err) {
    notice($("sign-notice"), "err", esc(err.message));
    btn.disabled = false;
    btn.textContent = "Signer le document";
  }
});

bootBrand();
load().catch((err) => notice($("error"), "err", esc(err.message)));
