// Phone side of the QR hand-off: claim the code, draw, send the drawing. No key is generated here.
import { api, bootBrand, esc, notice } from "./common.js";
import { enter, swapStep } from "./motion.js";
import { SignaturePad, replayStrokes } from "./pad.js";

const $ = (id) => document.getElementById(id);
const code = location.pathname.split("/").pop();
const steps = () => [$("loading"), $("draw"), $("sent")];

function fail(message) {
  $("loading").classList.add("hidden");
  notice($("error"), "err", esc(message));
}

async function start() {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(code)) return fail("Ce lien est incomplet. Scannez à nouveau le code sur l'ordinateur.");
  // The claim secret is kept per code so a reload, a prerender or a duplicate tab reuses it instead of voiding it.
  const claimKey = `handoff-claim:${code}`;
  const stored = (() => { try { return localStorage.getItem(claimKey); } catch { return null; } })();
  let claim;
  try {
    claim = await api(`/api/handoff/${code}/claim`, { method: "POST", body: stored ? { claim: stored } : {} });
    try { localStorage.setItem(claimKey, claim.claim); } catch { /* storage unavailable: single load still works */ }
  } catch (err) {
    return fail(err.message);
  }
  $("doc-title").textContent = claim.documentTitle;
  $("signer-name").textContent = claim.signerName;
  await swapStep(steps(), $("draw"));

  const pad = new SignaturePad($("pad"));
  pad.onChange = (empty) => ($("send").disabled = empty);
  $("pad-clear").addEventListener("click", () => pad.clear());
  $("send").addEventListener("click", async () => {
    const btn = $("send");
    btn.disabled = true;
    btn.textContent = "Envoi…";
    const strokes = pad.serialize();
    try {
      await api(`/api/handoff/${code}/drawing`, { method: "POST", body: { claim: claim.claim, signaturePng: pad.toPng(), strokes } });
      try { localStorage.removeItem(claimKey); } catch { /* ignore */ }
      await swapStep(steps(), $("sent"));
      await replayStrokes($("replay"), strokes, { duration: 1200 });
      $("check").classList.add("show");
    } catch (err) {
      notice($("notice"), "err", esc(err.message));
      if (err.status === 409 || err.status === 410 || err.status === 404) return; // terminal: keep the explanation on screen
      btn.disabled = false;
      btn.textContent = "Envoyer";
    }
  });
  enter($("draw"), { y: 0 });
}

bootBrand();
start();
