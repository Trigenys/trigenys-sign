import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFHexString, type PDFString } from "pdf-lib";
import { Anchors } from "../src/anchors.js";
import { canonicalJson, generateEd25519 } from "../src/crypto.js";
import { HttpError } from "../src/http.js";
import * as ots from "../src/ots.js";
import * as tsa from "../src/tsa.js";
import { linkToken, MINIMAL_PDF, testEnv, tick } from "./helpers.js";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const firstLink = (text: string) => text.match(/http:\/\/sign\.test\/s\/\S+/)![0];

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();
const CAL = "https://cal.test";
const TSA = "https://tsa.test/tsr";
const EXPLORER = "https://explorer.test/api";
const HEIGHT = 800_000;
const BLOCK_HASH = "00".repeat(32);
const BLOCK_TIME = 1_700_000_000;

// ---- OpenTimestamps: serialization round trip and merge

test("ots: detached proof serializes and parses back", () => {
  const digest = randomBytes(32);
  const nonce = randomBytes(16);
  const commitment = sha256(Buffer.concat([digest, nonce]));
  const proof: ots.DetachedProof = {
    digest,
    timestamp: {
      msg: digest,
      attestations: [],
      ops: [[{ tag: ots.OP.APPEND, arg: nonce }, { msg: Buffer.concat([digest, nonce]), attestations: [], ops: [[{ tag: ots.OP.SHA256 }, { msg: commitment, attestations: [{ kind: "pending", uri: CAL }, { kind: "bitcoin", height: HEIGHT }], ops: [] }]] }]],
    },
  };
  const bytes = ots.serializeProof(proof);
  const back = ots.parseProof(bytes);
  assert.ok(back.digest.equals(digest));
  const atts = ots.allAttestations(back.timestamp);
  assert.equal(atts.length, 2);
  assert.ok(atts.every((a) => a.msg.equals(commitment)));
  assert.deepEqual(atts.map((a) => a.attestation.kind).sort(), ["bitcoin", "pending"]);
  assert.ok(ots.serializeProof(back).equals(bytes), "re-serialization is byte-identical");
  assert.throws(() => ots.parseProof(Buffer.from("not an ots file")), /en-tête/);
});

// ---- Fake network: one calendar, one TSA, one block explorer

function fakeNetwork(opts: { confirmed: boolean }) {
  const calls: string[] = [];
  let digestSeen: Buffer | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url === `${CAL}/digest`) {
      const msg = Buffer.from(init!.body as ArrayBuffer);
      const ts: ots.Timestamp = { msg, attestations: [{ kind: "pending", uri: CAL }], ops: [] };
      return new Response(new Uint8Array(ots.serializeTimestamp(ts)), { status: 200 });
    }
    if (url.startsWith(`${CAL}/timestamp/`)) {
      if (!opts.confirmed) return new Response("pending", { status: 404 });
      const msg = Buffer.from(url.slice(`${CAL}/timestamp/`.length), "hex");
      const ts: ots.Timestamp = { msg, attestations: [], ops: [[{ tag: ots.OP.SHA256 }, { msg: sha256(msg), attestations: [{ kind: "bitcoin", height: HEIGHT }], ops: [] }]] };
      return new Response(new Uint8Array(ots.serializeTimestamp(ts)), { status: 200 });
    }
    if (url === `${EXPLORER}/block-height/${HEIGHT}`) return new Response(BLOCK_HASH, { status: 200 });
    if (url === `${EXPLORER}/block/${BLOCK_HASH}`) {
      // merkle_root is displayed byte-reversed by Esplora; the proof's final msg is sha256(commitment)
      const root = Buffer.from(sha256(digestSeen!)).reverse().toString("hex");
      return new Response(JSON.stringify({ merkle_root: root, timestamp: BLOCK_TIME }), { status: 200 });
    }
    if (url === TSA) {
      const req = Buffer.from(init!.body as ArrayBuffer);
      return new Response(new Uint8Array(fakeTsaResponse(req)), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchImpl, calls, rememberCommitment: (b: Buffer) => (digestSeen = b) };
}

// Minimal DER TimeStampResp around the digest and nonce found in the request.
function der(tag: number, body: Buffer): Buffer {
  const len = body.length < 0x80 ? Buffer.from([body.length]) : body.length < 0x100 ? Buffer.from([0x81, body.length]) : Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...b: Buffer[]) => der(0x30, Buffer.concat(b));
function fakeTsaResponse(req: Buffer): Buffer {
  // TimeStampReq = SEQ { INTEGER 1, SEQ messageImprint, INTEGER nonce, BOOLEAN certReq }
  const imprint = req.subarray(req.indexOf(Buffer.from([0x04, 0x20])) + 2, req.indexOf(Buffer.from([0x04, 0x20])) + 34);
  const afterImprint = req.indexOf(Buffer.from([0x04, 0x20])) + 34;
  const nonceLen = req[afterImprint + 1]!;
  const nonce = req.subarray(afterImprint + 2, afterImprint + 2 + nonceLen);
  const tstInfo = seq(
    der(0x02, Buffer.from([1])),
    der(0x06, Buffer.from("2b0601040181", "hex")), // 1.3.6.1.4.1 (any policy)
    seq(seq(der(0x06, Buffer.from("608648016503040201", "hex")), der(0x05, Buffer.alloc(0))), der(0x04, imprint)),
    der(0x02, Buffer.from([0x01, 0x02, 0x03])),
    der(0x18, Buffer.from("20250102030405Z", "ascii")),
    der(0x02, nonce),
  );
  const signedData = seq(der(0x02, Buffer.from([3])), der(0x31, Buffer.alloc(0)), seq(der(0x06, Buffer.from("2a864886f70d0109100104", "hex")), der(0xa0, der(0x04, tstInfo))));
  const token = seq(der(0x06, Buffer.from("2a864886f70d010702", "hex")), der(0xa0, signedData));
  return seq(seq(der(0x02, Buffer.from([0]))), token);
}

test("tsa: request is minimal DER and a granted response is parsed", async () => {
  const digest = randomBytes(32);
  const req = tsa.buildTimeStampReq(digest, Buffer.from([0x00, 0x00, 0x7f]));
  assert.ok(req.includes(Buffer.from([0x02, 0x01, 0x7f])), "nonce INTEGER uses minimal encoding");
  const net = fakeNetwork({ confirmed: false });
  const r = await tsa.requestTimestamp(digest, ["https://down.test/tsr", TSA], async (input, init) => (String(input).includes("down") ? new Response("", { status: 503 }) : net.fetchImpl(input, init)));
  assert.equal(r.url, TSA);
  assert.equal(r.info.genTime, "2025-01-02T03:04:05.000Z");
  assert.equal(r.info.serial, "010203");
  assert.equal(r.info.policy, "1.3.6.1.4.1");
  assert.ok(r.info.imprint.equals(digest));
  assert.match(r.errors["https://down.test/tsr"]!, /HTTP 503/);
  const refused = seq(seq(der(0x02, Buffer.from([2])), der(0x30, der(0x0c, Buffer.from("Bad request format", "utf8")))));
  assert.throws(() => tsa.parseTimeStampResp(refused), /statut 2 : Bad request format/);
});

// ---- End to end on a completed document

async function completedDocument() {
  const env = testEnv({ OTS_CALENDARS: CAL, TSA_URLS: TSA, BTC_EXPLORER_URL: EXPLORER });
  const { svc, notifier } = env;
  const owner = svc.upsertUser({ email: "boss@trigenys.com" });
  const doc = svc.createDocument(owner, { title: "Contrat", signers: [{ name: "Alice", email: "alice@trigenys.com" }] }, MINIMAL_PDF);
  await tick();
  const token = linkToken(firstLink(notifier.emails[0]!.msg.text));
  const k = generateEd25519();
  svc.enrollKey(token, { publicKeyJwk: k.jwk, signaturePng: PNG, strokes: [[[0.2, 0.5, 0], [0.8, 0.4, 80]]] });
  const { payload } = svc.signerContext(token);
  const res = await svc.sign(token, { payload, signature: k.sign(canonicalJson(payload)) });
  assert.equal(res.completed, true);
  await tick();
  return { ...env, owner, doc };
}

test("anchors: offline attempts are recorded as failed and the signed PDF still renders", async () => {
  const { svc, doc, owner } = await completedDocument();
  const v = svc.verify(doc.id);
  assert.deepEqual(v.anchors.map((a) => [a.kind, a.status]), [["ots", "failed"], ["tsa", "failed"]]);
  assert.match(v.anchors[0]!.detail.error!, /réseau désactivé/);
  const pdf = await PDFDocument.load(await svc.signedPdf(doc.id));
  const names = pdf.catalog.lookup(PDFName.of("Names"), PDFDict).lookup(PDFName.of("EmbeddedFiles"), PDFDict).lookup(PDFName.of("Names"), PDFArray);
  assert.equal(names.size(), 2, "only the manifest is attached when every anchor failed");
  const other = svc.upsertUser({ email: "other@trigenys.com" });
  await assert.rejects(svc.anchorNow(other, doc.id), (e: HttpError) => e.status === 403);
  await assert.rejects(svc.anchorNow(owner, "nope"), (e: HttpError) => e.status === 404);
});

test("anchors: pending Bitcoin proof, RFC 3161 token, then confirmation after upgrade", async () => {
  const { cfg, db, svc, doc } = await completedDocument();
  const net = fakeNetwork({ confirmed: false });
  const anchors = new Anchors(cfg, db, net.fetchImpl, { warn() {} });
  const subject = anchors.subjectOf(doc.id)!;
  assert.equal(subject.signatures.length, 1);
  assert.equal(subject.documentSha256, svc.getDocument(doc.id).sha256);

  let view = await anchors.anchorDocument(doc.id);
  const otsView = view.find((a) => a.kind === "ots")!;
  const tsaView = view.find((a) => a.kind === "tsa")!;
  assert.equal(otsView.status, "pending");
  assert.deepEqual(otsView.detail.calendars, [CAL]);
  assert.equal(tsaView.status, "confirmed");
  assert.equal(tsaView.anchoredAt, "2025-01-02T03:04:05.000Z");
  assert.equal(tsaView.provider, TSA);
  assert.equal(otsView.digest, Anchors.digestOf(subject));

  // Stored .ots commits to our digest through append(nonce) + sha256
  const proof = ots.parseProof(anchors.proof(doc.id, "ots")!.bytes);
  assert.ok(proof.digest.equals(Buffer.from(otsView.digest, "hex")));
  const pend = ots.allAttestations(proof.timestamp);
  assert.equal(pend.length, 1);
  assert.equal(pend[0]!.attestation.kind, "pending");
  net.rememberCommitment(pend[0]!.msg);
  assert.equal(anchors.proof(doc.id, "tsa")!.extension, "tsr");
  assert.doesNotThrow(() => tsa.parseTimeStampResp(anchors.proof(doc.id, "tsa")!.bytes));

  // Idempotent: a second pass is a no-op
  const before = net.calls.length;
  await anchors.anchorDocument(doc.id);
  assert.equal(net.calls.length, before);

  // Still pending at the calendar
  view = await anchors.upgrade(doc.id);
  assert.equal(view.find((a) => a.kind === "ots")!.status, "pending");

  // Calendar now returns the Bitcoin attestation; block is checked at the explorer
  const live = fakeNetwork({ confirmed: true });
  live.rememberCommitment(pend[0]!.msg);
  const confirmed = new Anchors(cfg, db, live.fetchImpl, { warn() {} });
  view = await confirmed.upgrade(doc.id);
  const done = view.find((a) => a.kind === "ots")!;
  assert.equal(done.status, "confirmed");
  assert.equal(done.detail.height, HEIGHT);
  assert.equal(done.detail.blockHash, BLOCK_HASH);
  assert.equal(done.anchoredAt, new Date(BLOCK_TIME * 1000).toISOString());
  const upgraded = ots.parseProof(confirmed.proof(doc.id, "ots")!.bytes);
  assert.ok(ots.allAttestations(upgraded.timestamp).some((a) => a.attestation.kind === "bitcoin"));

  // Final PDF carries both proofs and the timestamp block
  const svc2 = new (svc.constructor as new (...a: unknown[]) => typeof svc)(cfg, db, svc.notifier, confirmed);
  const pdf = await PDFDocument.load(await svc2.signedPdf(doc.id));
  const names = pdf.catalog.lookup(PDFName.of("Names"), PDFDict).lookup(PDFName.of("EmbeddedFiles"), PDFDict).lookup(PDFName.of("Names"), PDFArray);
  const attached: string[] = [];
  for (let i = 0; i < names.size(); i += 2) attached.push((names.lookup(i) as PDFHexString | PDFString).decodeText());
  assert.deepEqual(attached.sort(), ["trigenys-sign-manifest.json", "trigenys-sign-preuve.ots", "trigenys-sign-preuve.tsr"]);
  const manifest = svc2.verify(doc.id);
  assert.equal(manifest.anchors.filter((a) => a.status === "confirmed").length, 2);
});

test("anchors: sweep anchors completed documents retroactively", async () => {
  const { cfg, db, doc } = await completedDocument();
  db.run("DELETE FROM anchors WHERE document_id = ?", doc.id);
  const net = fakeNetwork({ confirmed: false });
  const anchors = new Anchors(cfg, db, net.fetchImpl, { warn() {} });
  const r = await anchors.sweep();
  assert.equal(r.anchored, 1);
  assert.deepEqual(anchors.view(doc.id).map((a) => a.status).sort(), ["confirmed", "pending"]);
  assert.deepEqual(await anchors.sweep(), { anchored: 0, upgraded: 0 });
});
