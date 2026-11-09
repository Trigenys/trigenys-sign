import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { canonicalJson, generateEd25519, keyFingerprint } from "../src/crypto.js";
import { HttpError } from "../src/http.js";
import { MINIMAL_PDF, linkToken, testEnv, tick } from "./helpers.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const firstLink = (text: string) => text.match(/http:\/\/sign\.test\/s\/\S+/)![0];

test("full signing flow: create, notify, enroll, sign, progress, verify, pdf", async () => {
  const { svc, notifier } = testEnv();
  const owner = svc.upsertUser({ email: "boss@trigenys.com", name: "Boss", phone: "+237600000001" });

  const doc = svc.createDocument(
    owner,
    { title: "Contrat", signers: [{ name: "Alice", email: "alice@trigenys.com", phone: "0033612345678" }, { name: "Bob", email: "bob@trigenys.com" }] },
    MINIMAL_PDF,
  );
  await tick();

  assert.equal(doc.status, "pending");
  assert.equal(notifier.emails.filter((e) => e.kind === "sign-request").length, 2);
  assert.equal(notifier.whatsapps.filter((w) => w.kind === "sign-request").length, 1, "only the signer with a phone gets WhatsApp");
  assert.equal(notifier.whatsapps[0]!.msg.recipient, "+33612345678");

  const token = linkToken(firstLink(notifier.emails.find((e) => e.msg.recipient === "alice@trigenys.com")!.msg.text));

  const ctx = svc.signerContext(token);
  assert.equal(ctx.key, null);
  assert.equal(ctx.payload, null);
  assert.equal(ctx.document.remaining, 2);

  const k = generateEd25519();
  svc.enrollKey(token, { publicKeyJwk: k.jwk, signaturePng: PNG, strokes: [[[0.1, 0.5, 0], [0.9, 0.5, 100]]] });
  const ctx2 = svc.signerContext(token);
  assert.equal(ctx2.key?.fingerprint, keyFingerprint(k.jwk));
  assert.ok(ctx2.payload);

  const bad = { ...ctx2.payload!, documentSha256: "0".repeat(64) };
  await assert.rejects(svc.sign(token, { payload: bad, signature: k.sign(canonicalJson(bad)) }), (e: HttpError) => e.status === 400);

  const other = generateEd25519();
  await assert.rejects(svc.sign(token, { payload: ctx2.payload, signature: other.sign(canonicalJson(ctx2.payload)) }), (e: HttpError) => e.status === 400);

  const res = await svc.sign(token, { payload: ctx2.payload, signature: k.sign(canonicalJson(ctx2.payload)) });
  await tick();
  assert.equal(res.completed, false);
  assert.equal(res.remaining, 1);
  const progress = notifier.emails.filter((e) => e.kind === "progress");
  assert.equal(progress.length, 1);
  assert.equal(progress[0]!.msg.recipient, "boss@trigenys.com");
  assert.equal(notifier.whatsapps.filter((w) => w.kind === "progress" && w.msg.recipient === "+237600000001").length, 1);

  await assert.rejects(svc.sign(token, { payload: ctx2.payload, signature: k.sign(canonicalJson(ctx2.payload)) }), (e: HttpError) => e.status === 409);

  const v = svc.verify(doc.id);
  assert.equal(v.fileIntact, true);
  assert.equal(v.allValid, false);
  assert.equal(v.signatures[0]!.signed, true);
  assert.equal(v.signatures[0]!.valid, true);
  assert.equal(v.signatures[1]!.signed, false);

  const pdf = await svc.signedPdf(doc.id);
  assert.equal(Buffer.from(pdf.subarray(0, 5)).toString("latin1"), "%PDF-");
  assert.ok(pdf.length > MINIMAL_PDF.length);
});

test("document completes when the last signer signs; tampered file is detected", async () => {
  const { svc, notifier } = testEnv();
  const owner = svc.upsertUser({ email: "boss@trigenys.com" });
  const doc = svc.createDocument(owner, { title: "NDA", signers: [{ name: "Alice", email: "alice@trigenys.com" }] }, MINIMAL_PDF);
  await tick();
  const token = linkToken(firstLink(notifier.emails[0]!.msg.text));
  const k = generateEd25519();
  svc.enrollKey(token, { publicKeyJwk: k.jwk, signaturePng: PNG, strokes: [[[0.2, 0.5, 0], [0.8, 0.4, 80]]] });
  const { payload } = svc.signerContext(token);
  const res = await svc.sign(token, { payload, signature: k.sign(canonicalJson(payload)) });
  assert.equal(res.completed, true);
  assert.equal(svc.getDocument(doc.id).status, "completed");
  assert.equal(svc.verify(doc.id).allValid, true);

  fs.appendFileSync(svc.getDocument(doc.id).file_path, "\n%tamper");
  const v = svc.verify(doc.id);
  assert.equal(v.fileIntact, false);
  assert.equal(v.signatures[0]!.valid, false);
});

test("input validation", () => {
  const { svc } = testEnv();
  const owner = svc.upsertUser({ email: "boss@trigenys.com" });
  assert.throws(() => svc.createDocument(owner, { title: "", signers: [{ name: "A", email: "a@x.com" }] }, MINIMAL_PDF), /Titre/);
  assert.throws(() => svc.createDocument(owner, { title: "T", signers: [] }, MINIMAL_PDF), /signataire/);
  assert.throws(() => svc.createDocument(owner, { title: "T", signers: [{ name: "A", email: "a@x.com" }] }, Buffer.from("hello")), /PDF/);
  assert.throws(() => svc.createDocument(owner, { title: "T", signers: [{ name: "A", email: "a@x.com" }, { name: "B", email: "A@x.com" }] }, MINIMAL_PDF), /deux fois/);
  assert.equal(svc.normalizePhone("00237 6 00 00 00 01"), "+237600000001");
  assert.equal(svc.normalizePhone(""), null);
  assert.throws(() => svc.normalizePhone("12"), HttpError);
  assert.equal(svc.canIssue("x@trigenys.com"), true);
  assert.equal(svc.canIssue("x@gmail.com"), false);
});

test("magic links are single use; foreign domains cannot log in", async () => {
  const { svc } = testEnv();
  const { link } = await svc.requestLogin("boss@trigenys.com");
  assert.ok(link);
  const token = link!.split("/auth/")[1]!;
  const user = svc.consumeLogin(token);
  assert.equal(user.email, "boss@trigenys.com");
  assert.throws(() => svc.consumeLogin(token), HttpError);
  await assert.rejects(svc.requestLogin("x@gmail.com"), HttpError);
});

test("contacts: signers already used by the owner, most recent first, filtered, owner excluded", async () => {
  const { svc } = testEnv();
  const owner = svc.upsertUser({ email: "owner@trigenys.com", name: "Owner" });
  const other = svc.upsertUser({ email: "other@trigenys.com" });
  svc.createDocument(owner, { title: "A", signers: [{ name: "Alice Martin", email: "alice@trigenys.com", phone: "+237670000001" }, { name: "Owner", email: "owner@trigenys.com" }] }, MINIMAL_PDF);
  await new Promise((r) => setTimeout(r, 5));
  svc.createDocument(owner, { title: "B", signers: [{ name: "Bob Durand", email: "bob@trigenys.com" }] }, MINIMAL_PDF);
  svc.createDocument(other, { title: "C", signers: [{ name: "Carl", email: "carl@trigenys.com" }] }, MINIMAL_PDF);
  const all = svc.listContacts(owner);
  assert.deepEqual(all.map((c) => c.email), ["bob@trigenys.com", "alice@trigenys.com"]);
  assert.equal(all[1]!.phone, "+237670000001");
  assert.deepEqual(svc.listContacts(owner, "ali").map((c) => c.email), ["alice@trigenys.com"]);
  assert.deepEqual(svc.listContacts(owner, "BOB@").map((c) => c.email), ["bob@trigenys.com"]);
  assert.deepEqual(svc.listContacts(other).map((c) => c.email), ["carl@trigenys.com"]);
});
