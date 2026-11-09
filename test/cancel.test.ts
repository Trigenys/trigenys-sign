import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, generateEd25519 } from "../src/crypto.js";
import { HttpError } from "../src/http.js";
import { createServer } from "../src/server.js";
import { MINIMAL_PDF, linkToken, testEnv, tick } from "./helpers.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const firstLink = (text: string) => text.match(/http:\/\/sign\.test\/s\/\S+/)![0];

test("cancel: one of three signed, then cancelled; links die with 410, pending signers are told, signatures stay", async () => {
  const { svc, notifier } = testEnv();
  const owner = svc.upsertUser({ email: "boss@trigenys.com", name: "Boss" });
  const other = svc.upsertUser({ email: "other@trigenys.com" });
  const doc = svc.createDocument(
    owner,
    { title: "Contrat", signers: [{ name: "Alice", email: "alice@trigenys.com" }, { name: "Bob", email: "bob@trigenys.com", phone: "+237600000002" }, { name: "Carl", email: "carl@trigenys.com" }] },
    MINIMAL_PDF,
  );
  await tick();
  const tokenOf = (email: string) => linkToken(firstLink(notifier.emails.find((e) => e.kind === "sign-request" && e.msg.recipient === email)!.msg.text));
  const alice = tokenOf("alice@trigenys.com");
  const k = generateEd25519();
  svc.enrollKey(alice, { publicKeyJwk: k.jwk, signaturePng: PNG, strokes: [[[0.1, 0.5, 0], [0.9, 0.5, 100]]] });
  const ctx = svc.signerContext(alice);
  await svc.sign(alice, { payload: ctx.payload, signature: k.sign(canonicalJson(ctx.payload)) });
  await tick();

  assert.throws(() => svc.cancelDocument(other, doc.id), (e: HttpError) => e.status === 403);
  const cancelled = svc.cancelDocument(owner, doc.id);
  await tick();
  assert.equal(cancelled.status, "cancelled");
  assert.ok(cancelled.cancelled_at);

  const mails = notifier.emails.filter((e) => e.kind === "cancelled").map((e) => e.msg.recipient).sort();
  assert.deepEqual(mails, ["bob@trigenys.com", "carl@trigenys.com"], "only signers who had not signed are told");
  assert.equal(notifier.whatsapps.filter((w) => w.kind === "cancelled").length, 1);
  assert.ok(notifier.emails.find((e) => e.kind === "cancelled")!.msg.text.includes(`/verify/${doc.id}`));

  // Idempotent: a second cancel changes nothing and sends nothing more.
  const again = svc.cancelDocument(owner, doc.id);
  await tick();
  assert.equal(again.cancelled_at, cancelled.cancelled_at);
  assert.equal(notifier.emails.filter((e) => e.kind === "cancelled").length, 2);

  // Every signer-token path is closed, including for the signer who already signed.
  for (const t of [alice, tokenOf("bob@trigenys.com")]) {
    assert.throws(() => svc.signerContext(t), (e: HttpError) => e.status === 410 && /annulé/.test(e.message));
    assert.throws(() => svc.signerStatus(t), (e: HttpError) => e.status === 410);
    await assert.rejects(svc.sign(t, { payload: ctx.payload, signature: "x" }), (e: HttpError) => e.status === 410);
  }

  // Existing signature remains verifiable, the document is reported cancelled.
  const v = svc.verify(doc.id);
  assert.equal(v.document.status, "cancelled");
  assert.ok(v.document.cancelledAt);
  assert.equal(v.signatures.filter((s) => s.signed).length, 1);
  assert.equal(v.signatures[0]!.valid, true);
  assert.equal(v.allValid, false);
  const view = svc.documentView(svc.getDocument(doc.id));
  assert.equal(view.status, "cancelled");
  assert.equal(view.signed, 1);
  assert.equal(view.supersededBy, null);
});

test("cancel: a completed document cannot be cancelled", async () => {
  const { svc, notifier } = testEnv();
  const owner = svc.upsertUser({ email: "boss@trigenys.com" });
  const doc = svc.createDocument(owner, { title: "NDA", signers: [{ name: "Alice", email: "alice@trigenys.com" }] }, MINIMAL_PDF);
  await tick();
  const token = linkToken(firstLink(notifier.emails[0]!.msg.text));
  const k = generateEd25519();
  svc.enrollKey(token, { publicKeyJwk: k.jwk, signaturePng: PNG, strokes: [[[0.1, 0.5, 0], [0.9, 0.5, 100]]] });
  const ctx = svc.signerContext(token);
  const r = await svc.sign(token, { payload: ctx.payload, signature: k.sign(canonicalJson(ctx.payload)) });
  assert.equal(r.completed, true);
  assert.throws(() => svc.cancelDocument(owner, doc.id), (e: HttpError) => e.status === 409);
  assert.equal(svc.getDocument(doc.id).status, "completed");
});

test("new version: supersedes links both documents; chain is one-to-one and owner-bound", async () => {
  const { svc } = testEnv();
  const owner = svc.upsertUser({ email: "boss@trigenys.com" });
  const other = svc.upsertUser({ email: "other@trigenys.com" });
  const signers = [{ name: "Alice", email: "alice@trigenys.com" }];
  const v1 = svc.createDocument(owner, { title: "Contrat v1", signers }, MINIMAL_PDF);
  svc.cancelDocument(owner, v1.id);
  await tick();

  assert.throws(() => svc.createDocument(other, { title: "Vol", signers, supersedes: v1.id }, MINIMAL_PDF), (e: HttpError) => e.status === 400);
  assert.throws(() => svc.createDocument(owner, { title: "x", signers, supersedes: "nope" }, MINIMAL_PDF), (e: HttpError) => e.status === 400);

  const v2 = svc.createDocument(owner, { title: "Contrat v2", signers, supersedes: v1.id }, MINIMAL_PDF);
  await tick();
  assert.equal(v2.supersedes_id, v1.id);
  assert.equal(v2.status, "pending");
  const oldView = svc.documentView(svc.getDocument(v1.id));
  const newView = svc.documentView(v2);
  assert.deepEqual(oldView.supersededBy, { id: v2.id, title: "Contrat v2", status: "pending" });
  assert.equal(oldView.supersedes, null);
  assert.deepEqual(newView.supersedes, { id: v1.id, title: "Contrat v1", status: "cancelled" });
  assert.equal(newView.supersededBy, null);
  assert.deepEqual(svc.verify(v1.id).document.supersededBy, { id: v2.id, title: "Contrat v2", status: "pending" });
  assert.deepEqual(svc.verify(v2.id).document.supersedes, { id: v1.id, title: "Contrat v1", status: "cancelled" });

  assert.throws(() => svc.createDocument(owner, { title: "Contrat v2 bis", signers, supersedes: v1.id }, MINIMAL_PDF), (e: HttpError) => e.status === 409);
  // Documents created without the field keep working as before.
  const plain = svc.createDocument(owner, { title: "Autre", signers }, MINIMAL_PDF);
  assert.equal(svc.documentView(plain).supersedes, null);
});

test("HTTP: POST /api/documents/:id/cancel and supersedes in X-Document-Meta", async () => {
  const { cfg, svc } = testEnv();
  const server = createServer(cfg, svc);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  try {
    const req = await fetch(`${base}/api/auth/request`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "boss@trigenys.com" }) }).then((r) => r.json() as Promise<{ link: string }>);
    const login = await fetch(req.link.replace("http://sign.test", base), { redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const h = { cookie };
    const meta = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
    const signers = [{ name: "Alice", email: "alice@trigenys.com" }];

    const v1 = await fetch(`${base}/api/documents`, { method: "POST", headers: { ...h, "content-type": "application/pdf", "x-document-meta": meta({ title: "v1", signers }) }, body: MINIMAL_PDF }).then((r) => r.json() as Promise<{ id: string; status: string }>);
    assert.equal(v1.status, "pending");

    const unauth = await fetch(`${base}/api/documents/${v1.id}/cancel`, { method: "POST" });
    assert.equal(unauth.status, 401);
    const c = await fetch(`${base}/api/documents/${v1.id}/cancel`, { method: "POST", headers: h });
    assert.equal(c.status, 200);
    const cj = (await c.json()) as { status: string; cancelledAt: string };
    assert.equal(cj.status, "cancelled");
    assert.ok(cj.cancelledAt);

    const v2 = await fetch(`${base}/api/documents`, { method: "POST", headers: { ...h, "content-type": "application/pdf", "x-document-meta": meta({ title: "v2", signers, supersedes: v1.id }) }, body: MINIMAL_PDF });
    assert.equal(v2.status, 201);
    const v2j = (await v2.json()) as { id: string; supersedes: { id: string } };
    assert.equal(v2j.supersedes.id, v1.id);

    const pub = (await fetch(`${base}/api/verify/${v1.id}`).then((r) => r.json())) as { document: { status: string; supersededBy: { id: string } } };
    assert.equal(pub.document.status, "cancelled");
    assert.equal(pub.document.supersededBy.id, v2j.id);

    const dup = await fetch(`${base}/api/documents`, { method: "POST", headers: { ...h, "content-type": "application/pdf", "x-document-meta": meta({ title: "v3", signers, supersedes: v1.id }) }, body: MINIMAL_PDF });
    assert.equal(dup.status, 409);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
