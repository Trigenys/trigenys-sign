import { randomBytes } from "node:crypto";

/**
 * Minimal RFC 3161 client: builds a DER TimeStampReq for a SHA-256 digest, submits it to a
 * public Time Stamping Authority and extracts the signed time (TSTInfo.genTime) from the
 * response. The full response is kept as the proof; third parties verify it with
 * `openssl ts -verify -in proof.tsr -digest <sha256> -CAfile <tsa chain>`.
 * The TSA signature itself is not re-verified here (no CMS/X.509 stack): the stored
 * token is the evidence, checked against the digest and nonce we sent.
 */

const OID_SHA256 = Buffer.from("608648016503040201", "hex"); // 2.16.840.1.101.3.4.2.1
const OID_SIGNED_DATA = Buffer.from("2a864886f70d010702", "hex"); // 1.2.840.113549.1.7.2
const OID_TST_INFO = Buffer.from("2a864886f70d0109100104", "hex"); // 1.2.840.113549.1.9.16.1.4

function der(tag: number, body: Buffer): Buffer {
  let len: Buffer;
  if (body.length < 0x80) len = Buffer.from([body.length]);
  else if (body.length < 0x100) len = Buffer.from([0x81, body.length]);
  else if (body.length < 0x10000) len = Buffer.from([0x82, body.length >> 8, body.length & 0xff]);
  else throw new Error("DER: contenu trop long");
  return Buffer.concat([Buffer.from([tag]), len, body]);
}
const seq = (...items: Buffer[]) => der(0x30, Buffer.concat(items));

/** DER INTEGER from unsigned big-endian bytes (minimal encoding, sign bit cleared). */
function derUnsignedInt(bytes: Buffer): Buffer {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  let b = bytes.subarray(i);
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return der(0x02, b);
}

export function buildTimeStampReq(digest: Buffer, nonce: Buffer): Buffer {
  if (digest.length !== 32) throw new Error("TSA: empreinte SHA-256 attendue");
  return seq(
    der(0x02, Buffer.from([1])), // version
    seq(seq(der(0x06, OID_SHA256), der(0x05, Buffer.alloc(0))), der(0x04, digest)), // messageImprint
    derUnsignedInt(nonce),
    der(0x01, Buffer.from([0xff])), // certReq TRUE: the response embeds the TSA certificate
  );
}

interface Tlv {
  tag: number;
  start: number; // first content byte
  end: number; // one past the last content byte
}

function readTlv(buf: Buffer, pos: number): Tlv {
  if (pos + 2 > buf.length) throw new Error("DER: fin de données inattendue");
  const tag = buf[pos]!;
  let len = buf[pos + 1]!;
  let p = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || p + n > buf.length) throw new Error("DER: longueur invalide");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p + i]!;
    p += n;
  }
  if (p + len > buf.length) throw new Error("DER: longueur hors limites");
  return { tag, start: p, end: p + len };
}

function children(buf: Buffer, t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  let p = t.start;
  while (p < t.end) {
    const c = readTlv(buf, p);
    out.push(c);
    p = c.end;
  }
  return out;
}
const content = (buf: Buffer, t: Tlv) => buf.subarray(t.start, t.end);
const expect = (t: Tlv | undefined, tag: number, what: string): Tlv => {
  if (!t || t.tag !== tag) throw new Error(`TSA: ${what} attendu`);
  return t;
};

function parseGeneralizedTime(s: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d{1,3})\d*)?Z$/.exec(s);
  if (!m) throw new Error(`TSA: date invalide ${s}`);
  const ms = (m[7] ?? "0").padEnd(3, "0");
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${ms}Z`;
}

export interface TsaInfo {
  /** Time asserted by the TSA, ISO 8601 UTC. */
  genTime: string;
  serial: string; // hex
  policy: string; // dotted OID
  imprint: Buffer;
  nonce: Buffer | null;
}

function decodeOid(b: Buffer): string {
  const parts: number[] = [];
  let v = 0;
  for (let i = 0; i < b.length; i++) {
    v = v * 128 + (b[i]! & 0x7f);
    if (!(b[i]! & 0x80)) {
      if (parts.length === 0) parts.push(Math.min(2, Math.floor(v / 40)), v - 40 * Math.min(2, Math.floor(v / 40)));
      else parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

/** Parse a TimeStampResp. Throws with the TSA's status text when the request was refused. */
export function parseTimeStampResp(buf: Buffer): TsaInfo {
  const resp = expect(readTlv(buf, 0), 0x30, "TimeStampResp");
  const [statusInfo, token] = children(buf, resp);
  const st = children(buf, expect(statusInfo, 0x30, "PKIStatusInfo"));
  const status = content(buf, expect(st[0], 0x02, "status")).reduce((a, b) => a * 256 + b, 0);
  if (status !== 0 && status !== 1) {
    const text = st[1]?.tag === 0x30 ? children(buf, st[1]).map((c) => content(buf, c).toString("utf8")).join(" ") : "";
    throw new Error(`TSA: requête refusée (statut ${status}${text ? ` : ${text}` : ""})`);
  }
  const ci = children(buf, expect(token, 0x30, "timeStampToken"));
  if (!content(buf, expect(ci[0], 0x06, "contentType")).equals(OID_SIGNED_DATA)) throw new Error("TSA: jeton non SignedData");
  const signedData = expect(children(buf, expect(ci[1], 0xa0, "content"))[0], 0x30, "SignedData");
  const encap = expect(children(buf, signedData)[2], 0x30, "encapContentInfo");
  const ec = children(buf, encap);
  if (!content(buf, expect(ec[0], 0x06, "eContentType")).equals(OID_TST_INFO)) throw new Error("TSA: contenu non TSTInfo");
  const tstBytes = content(buf, expect(children(buf, expect(ec[1], 0xa0, "eContent"))[0], 0x04, "eContent"));
  const tst = children(tstBytes, expect(readTlv(tstBytes, 0), 0x30, "TSTInfo"));
  const policy = decodeOid(content(tstBytes, expect(tst[1], 0x06, "policy")));
  const imprintParts = children(tstBytes, expect(tst[2], 0x30, "messageImprint"));
  const imprint = Buffer.from(content(tstBytes, expect(imprintParts[1], 0x04, "hashedMessage")));
  const serial = content(tstBytes, expect(tst[3], 0x02, "serialNumber")).toString("hex").replace(/^00(?=..)/, "");
  const genTime = parseGeneralizedTime(content(tstBytes, expect(tst[4], 0x18, "genTime")).toString("ascii"));
  const nonceTlv = tst.slice(5).find((t) => t.tag === 0x02);
  const nonce = nonceTlv ? Buffer.from(content(tstBytes, nonceTlv)) : null;
  return { genTime, serial, policy, imprint, nonce };
}

const stripInt = (b: Buffer) => {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  return b.subarray(i);
};

export interface TsaResult {
  url: string;
  token: Buffer; // full TimeStampResp (DER)
  info: TsaInfo;
  errors: Record<string, string>;
}

/** Try each TSA in order; the first granted response that matches our digest and nonce wins. */
export async function requestTimestamp(digest: Buffer, urls: string[], fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): Promise<TsaResult> {
  const errors: Record<string, string> = {};
  for (const url of urls) {
    try {
      const nonce = randomBytes(8);
      const res = await fetchImpl(url, { method: "POST", body: new Uint8Array(buildTimeStampReq(digest, nonce)).buffer as ArrayBuffer, headers: { "content-type": "application/timestamp-query", "user-agent": "trigenys-sign" }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const token = Buffer.from(await res.arrayBuffer());
      if (token.length > 65536) throw new Error("réponse trop volumineuse");
      const info = parseTimeStampResp(token);
      if (!info.imprint.equals(digest)) throw new Error("l'empreinte renvoyée ne correspond pas");
      if (info.nonce && !stripInt(info.nonce).equals(stripInt(nonce))) throw new Error("le nonce renvoyé ne correspond pas");
      return { url, token, info, errors };
    } catch (e) {
      errors[url] = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`Aucune autorité d'horodatage n'a répondu (${Object.entries(errors).map(([u, m]) => `${u}: ${m}`).join(" ; ")})`);
}
