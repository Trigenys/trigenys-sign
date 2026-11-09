import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, generateEd25519, keyFingerprint } from "../src/crypto.js";
import { HttpError } from "../src/http.js";
import { qrSvg } from "../src/qr.js";
import { MINIMAL_PDF, linkToken, testEnv, tick } from "./helpers.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const STROKES = [[[0.1, 0.5, 0], [0.9, 0.5, 100]]];
const firstLink = (text: string) => text.match(/http:\/\/sign\.test\/s\/\S+/)![0];

async function signerToken(overrides: Record<string, string> = {}) {
  const env = testEnv(overrides);
  const owner = env.svc.upsertUser({ email: "boss@trigenys.com", name: "Boss" });
  env.svc.createDocument(owner, { title: "Contrat", signers: [{ name: "Alice", email: "alice@trigenys.com" }] }, MINIMAL_PDF);
  await tick();
  const token = linkToken(firstLink(env.notifier.emails[0]!.msg.text));
  return { ...env, token };
}

const codeOf = (url: string) => url.split("/h/")[1]!;
const rejects = (fn: () => unknown, status: number) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HttpError, String(e));
    assert.equal(e.status, status);
    return;
  }
  assert.fail(`expected HTTP ${status}`);
};

test("qrSvg renders a valid single-path SVG that scales with content", () => {
  const small = qrSvg("http://sign.test/h/abc");
  assert.match(small, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (\d+) \1"/);
  assert.match(small, /<path d="M4 4h1v1h-1z/); // first module after the 4-module quiet zone
  const big = qrSvg("http://sign.test/h/" + "x".repeat(120));
  const size = (svg: string) => Number(svg.match(/viewBox="0 0 (\d+)/)![1]);
  assert.ok(size(big) > size(small));
  assert.equal((size(small) - 8 - 21) % 4, 0, "module count is 21 + 4k, plus a 4-module quiet zone on each side");
});

test("hand-off: desktop creates code, phone claims and submits, desktop enrolls with handoffId", async () => {
  const { svc, token } = await signerToken();
  const h = svc.createHandoff(token);
  assert.match(h.url, /^http:\/\/sign\.test\/h\/[A-Za-z0-9_-]{32}$/);
  assert.match(h.qrSvg, /^<svg /);
  assert.equal(h.ttlSeconds, 600);
  assert.equal(svc.handoffStatus(token, h.id).state, "waiting");

  const code = codeOf(h.url);
  const claim = svc.claimHandoff(code);
  assert.equal(claim.signerName, "Alice");
  assert.equal(claim.documentTitle, "Contrat");
  assert.equal(svc.handoffStatus(token, h.id).state, "claimed");

  rejects(() => svc.submitHandoffDrawing(code, { claim: "wrong", signaturePng: PNG, strokes: STROKES }), 403);
  rejects(() => svc.submitHandoffDrawing(code, { claim: claim.claim, signaturePng: PNG, strokes: [] }), 400);
  svc.submitHandoffDrawing(code, { claim: claim.claim, signaturePng: PNG, strokes: STROKES });

  const st = svc.handoffStatus(token, h.id);
  assert.equal(st.state, "submitted");
  assert.equal(st.signaturePng, PNG);
  assert.deepEqual(st.strokes, STROKES);
  rejects(() => svc.claimHandoff(code), 409);
  rejects(() => svc.submitHandoffDrawing(code, { claim: claim.claim, signaturePng: PNG, strokes: STROKES }), 409);

  const k = generateEd25519();
  const key = svc.enrollKey(token, { publicKeyJwk: k.jwk, handoffId: h.id });
  assert.equal(key.signature_png, PNG);
  assert.equal(svc.signerContext(token).key?.fingerprint, keyFingerprint(k.jwk));
  assert.equal(svc.handoffStatus(token, h.id).state, "consumed");
  assert.equal(svc.signerStatus(token).keyFingerprint, keyFingerprint(k.jwk));
  rejects(() => svc.enrollKey(token, { publicKeyJwk: generateEd25519().jwk, handoffId: h.id }), 409);
});

test("hand-off: codes are hashed, scoped to the signer, cancellable and single-active", async () => {
  const { svc, db, token } = await signerToken();
  const h1 = svc.createHandoff(token);
  const row = db.get<{ code_hash: string }>("SELECT code_hash FROM handoffs WHERE id = ?", h1.id)!;
  assert.notEqual(row.code_hash, codeOf(h1.url));
  assert.equal(row.code_hash.length, 64);

  const h2 = svc.createHandoff(token);
  assert.equal(svc.handoffStatus(token, h1.id).state, "cancelled", "a new code cancels the previous one");
  rejects(() => svc.claimHandoff(codeOf(h1.url)), 410);
  rejects(() => svc.claimHandoff("nope"), 404);

  svc.cancelHandoff(token, h2.id);
  svc.cancelHandoff(token, h2.id); // idempotent
  assert.equal(svc.handoffStatus(token, h2.id).state, "cancelled");

  // Another signer cannot read this hand-off (anti-IDOR)
  const owner = svc.upsertUser({ email: "boss@trigenys.com" });
  const { notifier } = svc as never as { notifier: { emails: Array<{ msg: { text: string } }> } };
  svc.createDocument(owner, { title: "Autre", signers: [{ name: "Bob", email: "bob@trigenys.com" }] }, MINIMAL_PDF);
  await tick();
  const other = linkToken(firstLink(notifier.emails.at(-1)!.msg.text));
  rejects(() => svc.handoffStatus(other, h2.id), 404);
  rejects(() => svc.enrollKey(other, { publicKeyJwk: generateEd25519().jwk, handoffId: h2.id }), 404);
});

test("hand-off: expiry honours HANDOFF_TTL_MINUTES and a signed signer cannot create codes", async () => {
  const { svc, db, token } = await signerToken({ HANDOFF_TTL_MINUTES: "2" });
  const h = svc.createHandoff(token);
  assert.equal(h.ttlSeconds, 120);
  db.run("UPDATE handoffs SET expires_at = ? WHERE id = ?", new Date(Date.now() - 1000).toISOString(), h.id);
  assert.equal(svc.handoffStatus(token, h.id).state, "expired");
  rejects(() => svc.claimHandoff(codeOf(h.url)), 410);

  rejects(() => svc.enrollKey(token, { publicKeyJwk: generateEd25519().jwk, handoffId: "missing" }), 404);
  const k = generateEd25519();
  svc.enrollKey(token, { publicKeyJwk: k.jwk, signaturePng: PNG, strokes: STROKES });
  const ctx = svc.signerContext(token);
  await svc.sign(token, { payload: ctx.payload, signature: k.sign(canonicalJson(ctx.payload)) });
  assert.ok(svc.signerStatus(token).signedAt);
  rejects(() => svc.createHandoff(token), 409);
});

test("hand-off: rate limit of 20 codes per hour per signer", async () => {
  const { svc, token } = await signerToken();
  for (let i = 0; i < 20; i++) svc.createHandoff(token);
  rejects(() => svc.createHandoff(token), 429);
});
