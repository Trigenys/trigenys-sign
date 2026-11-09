import crypto from "node:crypto";

export const sha256Hex = (data: Buffer | string): string =>
  crypto.createHash("sha256").update(data).digest("hex");

export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString("base64url");

export const newId = (): string => crypto.randomUUID();

/** Deterministic 64-hex id for an idempotent Notify envelope. */
export const notifyId = (...parts: string[]): string => sha256Hex(parts.join("\u0000"));

export function hmacSign(secret: string, value: string): string {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

export function signCookie(secret: string, value: string): string {
  return `${value}.${hmacSign(secret, value)}`;
}

export function verifyCookie(secret: string, signed: string | undefined): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  if (i <= 0) return null;
  const value = signed.slice(0, i);
  const mac = signed.slice(i + 1);
  const expected = hmacSign(secret, value);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return value;
}

/** Canonical JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export function isEd25519Jwk(v: unknown): v is Ed25519Jwk {
  if (!v || typeof v !== "object") return false;
  const j = v as Record<string, unknown>;
  return j.kty === "OKP" && j.crv === "Ed25519" && typeof j.x === "string" && /^[A-Za-z0-9_-]{43}$/.test(j.x);
}

export function keyFingerprint(jwk: Ed25519Jwk): string {
  // RFC 7638 thumbprint for OKP keys.
  return sha256Hex(canonicalJson({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }));
}

export function verifyEd25519(jwk: Ed25519Jwk, message: string, signatureB64url: string): boolean {
  try {
    const key = crypto.createPublicKey({ key: { ...jwk }, format: "jwk" });
    const sig = Buffer.from(signatureB64url, "base64url");
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    return false;
  }
}

/** Test helper and reference implementation of the browser side. */
export function generateEd25519(): { jwk: Ed25519Jwk; sign: (message: string) => string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as Ed25519Jwk;
  return {
    jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x },
    sign: (message) => crypto.sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url"),
  };
}
