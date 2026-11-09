import { createHash, randomBytes } from "node:crypto";

/**
 * Minimal OpenTimestamps client (https://opentimestamps.org): serialization of the
 * detached-proof format, submission to public calendar servers, later upgrade to a
 * Bitcoin block attestation, and verification of that attestation against a block
 * explorer. No wallet, no fees. Proofs stay readable by the reference clients
 * (`ots verify`, `ots upgrade`).
 */

export type Attestation =
  | { kind: "pending"; uri: string }
  | { kind: "bitcoin"; height: number }
  | { kind: "unknown"; tag: Buffer; payload: Buffer };

/** Commitment operation: unary hash/transform ops carry no argument, append/prepend do. */
export interface Op {
  tag: number;
  arg?: Buffer;
}

export interface Timestamp {
  msg: Buffer;
  attestations: Attestation[];
  ops: Array<[Op, Timestamp]>;
}

export const OP = { APPEND: 0xf0, PREPEND: 0xf1, REVERSE: 0xf2, HEXLIFY: 0xf3, SHA1: 0x02, RIPEMD160: 0x03, SHA256: 0x08, KECCAK256: 0x67 } as const;
const PENDING_TAG = Buffer.from("83dfe30d2ef90c8e", "hex");
const BITCOIN_TAG = Buffer.from("0588960d73d71901", "hex");
const HEADER_MAGIC = Buffer.concat([Buffer.from("\x00OpenTimestamps\x00\x00Proof\x00", "latin1"), Buffer.from("bf89e2e884e89294", "hex")]);
const MAX_RESULT = 4096;

class Reader {
  pos = 0;
  constructor(private readonly buf: Buffer) {}
  get done() {
    return this.pos >= this.buf.length;
  }
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error("OTS: fin de données inattendue");
    return this.buf[this.pos++]!;
  }
  bytes(n: number): Buffer {
    if (this.pos + n > this.buf.length) throw new Error("OTS: fin de données inattendue");
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return Buffer.from(b);
  }
  varuint(): number {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) return value;
      shift += 7;
      if (shift > 56) throw new Error("OTS: varuint trop long");
    }
  }
  varbytes(max = MAX_RESULT): Buffer {
    const n = this.varuint();
    if (n > max) throw new Error("OTS: champ trop long");
    return this.bytes(n);
  }
}

function varuint(value: number): Buffer {
  const out: number[] = [];
  while (value > 0x7f) {
    out.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
  return Buffer.from(out);
}
const varbytes = (b: Buffer): Buffer => Buffer.concat([varuint(b.length), b]);

export function applyOp(op: Op, msg: Buffer): Buffer {
  switch (op.tag) {
    case OP.APPEND:
      return Buffer.concat([msg, op.arg!]);
    case OP.PREPEND:
      return Buffer.concat([op.arg!, msg]);
    case OP.REVERSE:
      return Buffer.from(msg).reverse();
    case OP.HEXLIFY:
      return Buffer.from(msg.toString("hex"), "ascii");
    case OP.SHA1:
      return createHash("sha1").update(msg).digest();
    case OP.RIPEMD160:
      return createHash("ripemd160").update(msg).digest();
    case OP.SHA256:
      return createHash("sha256").update(msg).digest();
    default:
      throw new Error(`OTS: opération non prise en charge 0x${op.tag.toString(16)}`);
  }
}

function readOp(tag: number, r: Reader): Op {
  if (tag === OP.APPEND || tag === OP.PREPEND) return { tag, arg: r.varbytes() };
  if (tag === OP.REVERSE || tag === OP.HEXLIFY || tag === OP.SHA1 || tag === OP.RIPEMD160 || tag === OP.SHA256 || tag === OP.KECCAK256) return { tag };
  throw new Error(`OTS: opération inconnue 0x${tag.toString(16)}`);
}
const writeOp = (op: Op): Buffer => (op.arg ? Buffer.concat([Buffer.from([op.tag]), varbytes(op.arg)]) : Buffer.from([op.tag]));
const sameOp = (a: Op, b: Op) => a.tag === b.tag && (a.arg ? !!b.arg && a.arg.equals(b.arg) : !b.arg);

function readAttestation(r: Reader): Attestation {
  const tag = r.bytes(8);
  const payload = r.varbytes(8192);
  if (tag.equals(PENDING_TAG)) {
    const uri = new Reader(payload).varbytes(1000).toString("utf8");
    if (!/^[A-Za-z0-9._/:-]+$/.test(uri)) throw new Error("OTS: URI de calendrier invalide");
    return { kind: "pending", uri };
  }
  if (tag.equals(BITCOIN_TAG)) return { kind: "bitcoin", height: new Reader(payload).varuint() };
  return { kind: "unknown", tag, payload };
}
function writeAttestation(a: Attestation): Buffer {
  if (a.kind === "pending") return Buffer.concat([PENDING_TAG, varbytes(varbytes(Buffer.from(a.uri, "utf8")))]);
  if (a.kind === "bitcoin") return Buffer.concat([BITCOIN_TAG, varbytes(varuint(a.height))]);
  return Buffer.concat([a.tag, varbytes(a.payload)]);
}
const attestationKey = (a: Attestation) => writeAttestation(a).toString("hex");

function readTimestamp(r: Reader, msg: Buffer, depth = 0): Timestamp {
  if (depth > 256) throw new Error("OTS: preuve trop profonde");
  const ts: Timestamp = { msg, attestations: [], ops: [] };
  const item = (tag: number) => {
    if (tag === 0x00) {
      ts.attestations.push(readAttestation(r));
    } else {
      const op = readOp(tag, r);
      const next = applyOp(op, msg);
      if (next.length > MAX_RESULT) throw new Error("OTS: résultat trop long");
      ts.ops.push([op, readTimestamp(r, next, depth + 1)]);
    }
  };
  let tag = r.byte();
  while (tag === 0xff) {
    item(r.byte());
    tag = r.byte();
  }
  item(tag);
  return ts;
}

export function serializeTimestamp(ts: Timestamp): Buffer {
  if (ts.attestations.length + ts.ops.length === 0) throw new Error("OTS: horodatage vide");
  const parts: Buffer[] = [];
  const atts = [...ts.attestations].sort((a, b) => attestationKey(a).localeCompare(attestationKey(b)));
  const ops = [...ts.ops].sort((a, b) => writeOp(a[0]).compare(writeOp(b[0])));
  atts.forEach((a, i) => {
    const last = i === atts.length - 1 && ops.length === 0;
    parts.push(Buffer.from(last ? [0x00] : [0xff, 0x00]), writeAttestation(a));
  });
  ops.forEach(([op, sub], i) => {
    if (i < ops.length - 1) parts.push(Buffer.from([0xff]));
    parts.push(writeOp(op), serializeTimestamp(sub));
  });
  return Buffer.concat(parts);
}

/** Merge `other` (same msg) into `into`, deduplicating attestations and shared op paths. */
export function mergeTimestamp(into: Timestamp, other: Timestamp): void {
  if (!into.msg.equals(other.msg)) throw new Error("OTS: fusion de messages différents");
  const known = new Set(into.attestations.map(attestationKey));
  for (const a of other.attestations) if (!known.has(attestationKey(a))) into.attestations.push(a);
  for (const [op, sub] of other.ops) {
    const existing = into.ops.find(([o]) => sameOp(o, op));
    if (existing) mergeTimestamp(existing[1], sub);
    else into.ops.push([op, sub]);
  }
}

/** Every attestation in the tree with the message it attests. */
export function allAttestations(ts: Timestamp): Array<{ msg: Buffer; attestation: Attestation; node: Timestamp }> {
  const out: Array<{ msg: Buffer; attestation: Attestation; node: Timestamp }> = [];
  const walk = (t: Timestamp) => {
    for (const a of t.attestations) out.push({ msg: t.msg, attestation: a, node: t });
    for (const [, sub] of t.ops) walk(sub);
  };
  walk(ts);
  return out;
}

export interface DetachedProof {
  digest: Buffer;
  timestamp: Timestamp;
}

export function serializeProof(p: DetachedProof): Buffer {
  return Buffer.concat([HEADER_MAGIC, varuint(1), Buffer.from([OP.SHA256]), p.digest, serializeTimestamp(p.timestamp)]);
}

export function parseProof(buf: Buffer): DetachedProof {
  if (buf.length < HEADER_MAGIC.length || !buf.subarray(0, HEADER_MAGIC.length).equals(HEADER_MAGIC)) throw new Error("OTS: en-tête invalide");
  const r = new Reader(buf);
  r.bytes(HEADER_MAGIC.length);
  const version = r.varuint();
  if (version !== 1) throw new Error(`OTS: version ${version} non prise en charge`);
  const hashOp = r.byte();
  if (hashOp !== OP.SHA256) throw new Error("OTS: seule l'empreinte SHA-256 est prise en charge");
  const digest = r.bytes(32);
  const timestamp = readTimestamp(r, digest);
  if (!r.done) throw new Error("OTS: données en trop après la preuve");
  return { digest, timestamp };
}

const HEADERS = { accept: "application/vnd.opentimestamps.v1", "user-agent": "trigenys-sign" };

async function fetchBytes(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; body: Buffer }> {
  const res = await fetchImpl(url, { ...init, headers: { ...HEADERS, ...(init.headers as Record<string, string> | undefined) }, signal: AbortSignal.timeout(timeoutMs) });
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > 65536) throw new Error("OTS: réponse trop volumineuse");
  return { status: res.status, body };
}

export interface StampResult {
  proof: DetachedProof;
  calendars: string[];
  errors: Record<string, string>;
}

/**
 * Submit a SHA-256 digest to the calendars. A random nonce is appended first (as the
 * reference client does) so the calendars never see the digest itself.
 */
export async function stamp(digest: Buffer, calendars: string[], fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<StampResult> {
  if (digest.length !== 32) throw new Error("OTS: empreinte SHA-256 attendue");
  const root: Timestamp = { msg: digest, attestations: [], ops: [] };
  const appendOp: Op = { tag: OP.APPEND, arg: randomBytes(16) };
  const appended: Timestamp = { msg: applyOp(appendOp, digest), attestations: [], ops: [] };
  root.ops.push([appendOp, appended]);
  const shaOp: Op = { tag: OP.SHA256 };
  const commitment: Timestamp = { msg: applyOp(shaOp, appended.msg), attestations: [], ops: [] };
  appended.ops.push([shaOp, commitment]);

  const ok: string[] = [];
  const errors: Record<string, string> = {};
  await Promise.all(
    calendars.map(async (cal) => {
      try {
        const { status, body } = await fetchBytes(fetchImpl, `${cal.replace(/\/$/, "")}/digest`, { method: "POST", body: new Uint8Array(commitment.msg).buffer as ArrayBuffer, headers: { "content-type": "application/x-www-form-urlencoded" } }, timeoutMs);
        if (status !== 200) throw new Error(`HTTP ${status}`);
        mergeTimestamp(commitment, readTimestamp(new Reader(body), commitment.msg));
        ok.push(cal);
      } catch (e) {
        errors[cal] = e instanceof Error ? e.message : String(e);
      }
    }),
  );
  if (ok.length === 0) throw new Error(`Aucun calendrier OpenTimestamps joignable (${Object.values(errors).join(" ; ")})`);
  return { proof: { digest, timestamp: root }, calendars: ok.sort(), errors };
}

export interface UpgradeResult {
  changed: boolean;
  /** Bitcoin attestations present after the upgrade, with the merkle root each one commits to. */
  bitcoin: Array<{ height: number; merkleRoot: Buffer }>;
  errors: Record<string, string>;
}

/** Ask each calendar whether its pending attestation has been committed to Bitcoin yet. */
export async function upgrade(proof: DetachedProof, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<UpgradeResult> {
  let changed = false;
  const errors: Record<string, string> = {};
  const pending = allAttestations(proof.timestamp).filter((a) => a.attestation.kind === "pending");
  await Promise.all(
    pending.map(async ({ msg, attestation, node }) => {
      if (attestation.kind !== "pending") return;
      try {
        const { status, body } = await fetchBytes(fetchImpl, `${attestation.uri.replace(/\/$/, "")}/timestamp/${msg.toString("hex")}`, { method: "GET" }, timeoutMs);
        if (status === 404) return; // still pending on this calendar
        if (status !== 200) throw new Error(`HTTP ${status}`);
        const before = serializeTimestamp(node).length;
        mergeTimestamp(node, readTimestamp(new Reader(body), msg));
        if (serializeTimestamp(node).length !== before) changed = true;
      } catch (e) {
        errors[attestation.uri] = e instanceof Error ? e.message : String(e);
      }
    }),
  );
  const bitcoin = allAttestations(proof.timestamp)
    .filter((a) => a.attestation.kind === "bitcoin")
    .map((a) => ({ height: (a.attestation as { height: number }).height, merkleRoot: a.msg }));
  return { changed, bitcoin, errors };
}

export interface BlockCheck {
  height: number;
  blockHash: string;
  blockTime: string; // ISO
  merkleMatches: boolean;
}

/**
 * Independently verify a Bitcoin attestation: the merkle root the proof commits to must be
 * the merkle root of the block at that height (Esplora-compatible explorer API).
 */
export async function checkBitcoinBlock(explorerUrl: string, height: number, merkleRoot: Buffer, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<BlockCheck> {
  const base = explorerUrl.replace(/\/$/, "");
  const h = await fetchImpl(`${base}/block-height/${height}`, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "trigenys-sign" } });
  if (h.status !== 200) throw new Error(`Explorateur : bloc ${height} introuvable (HTTP ${h.status})`);
  const blockHash = (await h.text()).trim();
  if (!/^[0-9a-f]{64}$/.test(blockHash)) throw new Error("Explorateur : hash de bloc invalide");
  const b = await fetchImpl(`${base}/block/${blockHash}`, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "trigenys-sign" } });
  if (b.status !== 200) throw new Error(`Explorateur : HTTP ${b.status}`);
  const json = (await b.json()) as { merkle_root?: string; timestamp?: number };
  if (typeof json.merkle_root !== "string" || typeof json.timestamp !== "number") throw new Error("Explorateur : réponse inattendue");
  // Explorers print hashes in display order; the proof commits to the internal byte order.
  const merkleMatches = Buffer.from(json.merkle_root, "hex").reverse().equals(merkleRoot);
  return { height, blockHash, blockTime: new Date(json.timestamp * 1000).toISOString(), merkleMatches };
}
