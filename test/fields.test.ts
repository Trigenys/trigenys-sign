import assert from "node:assert/strict";
import { test } from "node:test";
import { PDFDocument, PDFName, PDFDict } from "pdf-lib";
import { canonicalJson, generateEd25519 } from "../src/crypto.js";
import { HttpError } from "../src/http.js";
import { parseField } from "../src/pdf.js";
import { MINIMAL_PDF, linkToken, testEnv, tick } from "./helpers.js";

// 1x1 opaque PNG: a real image, so placement really embeds it.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const firstLink = (text: string) => text.match(/http:\/\/sign\.test\/s\/\S+/)![0];
const FIELD = { page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.08 };

const rejects = (fn: () => unknown, status: number, re?: RegExp) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof HttpError, String(e));
    assert.equal(e.status, status);
    if (re) assert.match(e.message, re);
    return;
  }
  assert.fail(`expected HTTP ${status}`);
};

async function signAs(svc: ReturnType<typeof testEnv>["svc"], token: string) {
  const k = generateEd25519();
  svc.enrollKey(token, { publicKeyJwk: k.jwk, signaturePng: PNG, strokes: [[[0.1, 0.5, 0], [0.9, 0.5, 100]]] });
  const { payload } = svc.signerContext(token);
  return svc.sign(token, { payload, signature: k.sign(canonicalJson(payload)) });
}

function imageCount(doc: PDFDocument, pageIndex: number): number {
  const res = doc.getPage(pageIndex).node.Resources();
  const xo = res?.lookup(PDFName.of("XObject"));
  if (!(xo instanceof PDFDict)) return 0;
  return xo.keys().filter((k) => (xo.lookup(k) as { dict?: PDFDict })?.dict?.lookup(PDFName.of("Subtype")) === PDFName.of("Image")).length;
}

test("parseField validates and normalizes a signature box", () => {
  assert.deepEqual(parseField({ page: 2, x: 0.12345, y: 0.5, w: 0.2, h: 0.1 }), { page: 2, x: 0.1235, y: 0.5, w: 0.2, h: 0.1 });
  assert.equal(parseField(null), null);
  assert.equal(parseField({ page: 0, x: 0, y: 0, w: 0.2, h: 0.1 }), null, "page is 1-based");
  assert.equal(parseField({ page: 1, x: 0.9, y: 0, w: 0.2, h: 0.1 }), null, "box must stay inside the page");
  assert.equal(parseField({ page: 1, x: 0, y: 0, w: 0.001, h: 0.1 }), null, "degenerate box");
  assert.equal(parseField({ page: "1", x: "a", y: 0, w: 0.2, h: 0.1 }), null);
});

test("fields are stored at creation, editable by the owner until a signature exists, and embedded in the final PDF", async () => {
  const { svc, notifier } = testEnv();
  const owner = svc.upsertUser({ email: "boss@trigenys.com", name: "Boss" });
  const other = svc.upsertUser({ email: "other@trigenys.com", name: "Other" });

  assert.throws(
    () => svc.createDocument(owner, { title: "T", signers: [{ name: "A", email: "a@x.com", field: { page: 1, x: 2, y: 0, w: 0.2, h: 0.1 } }] }, MINIMAL_PDF),
    (e: HttpError) => e.status === 400 && /Emplacement/.test(e.message),
  );

  const doc = svc.createDocument(
    owner,
    { title: "Contrat", signers: [{ name: "Alice", email: "alice@trigenys.com", field: FIELD }, { name: "Bob", email: "bob@trigenys.com" }] },
    MINIMAL_PDF,
  );
  await tick();
  const [alice, bob] = svc.documentView(doc).signers;
  assert.deepEqual(alice!.field, FIELD);
  assert.equal(bob!.field, null);

  rejects(() => svc.setFields(other, doc.id, { [bob!.id]: FIELD }), 403);
  rejects(() => svc.setFields(owner, doc.id, { nope: FIELD }), 400, /inconnu/);
  rejects(() => svc.setFields(owner, doc.id, { [bob!.id]: { page: 1, x: 0.5, y: 0.5, w: 0.9, h: 0.1 } }), 400, /Emplacement/);
  rejects(() => svc.setFields(owner, doc.id, [FIELD]), 400);

  // Idempotent: re-sending the current state writes nothing and succeeds.
  const same = svc.setFields(owner, doc.id, { [alice!.id]: FIELD, [bob!.id]: null });
  assert.deepEqual(same.signers.map((s) => s.field), [FIELD, null]);

  const bobField = { page: 1, x: 0.55, y: 0.8, w: 0.3, h: 0.08 };
  const updated = svc.setFields(owner, doc.id, { [bob!.id]: bobField });
  assert.deepEqual(updated.signers[1]!.field, bobField);
  assert.deepEqual(updated.signers[0]!.field, FIELD, "untouched signers keep their field");

  // Alice signs: zones stay editable (the final PDF is rendered on download).
  const aliceToken = linkToken(firstLink(notifier.emails.find((e) => e.msg.recipient === "alice@trigenys.com")!.msg.text));
  await signAs(svc, aliceToken);
  assert.equal(svc.setFields(owner, doc.id, { [alice!.id]: null }).signers[0]!.field, null, "a signed signer's zone can be cleared");
  svc.setFields(owner, doc.id, { [alice!.id]: FIELD, [bob!.id]: { ...bobField, x: 0.6 } });
  assert.deepEqual(svc.documentView(doc).signers[0]!.field, FIELD, "and set again");

  // Final PDF: original page count + signatures sheet; Alice's image sits on page 1, the sheet has its own copy.
  const out = await svc.signedPdf(doc.id);
  const original = await PDFDocument.load(MINIMAL_PDF);
  const signed = await PDFDocument.load(out);
  assert.equal(signed.getPageCount(), original.getPageCount() + 1);
  assert.equal(imageCount(signed, 0), 1, "one signature placed on page 1");

  // Without any field the original pages stay untouched.
  const plain = svc.createDocument(owner, { title: "Plain", signers: [{ name: "Carl", email: "carl@trigenys.com" }] }, MINIMAL_PDF);
  await tick();
  await signAs(svc, linkToken(firstLink(notifier.emails.find((e) => e.msg.recipient === "carl@trigenys.com")!.msg.text)));
  const plainSigned = await PDFDocument.load(await svc.signedPdf(plain.id));
  assert.equal(imageCount(plainSigned, 0), 0);
});
