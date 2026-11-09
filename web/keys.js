// Browser-side signing identity: a non-extractable Ed25519 key pair kept in IndexedDB.
// The private key never leaves this device; the server only knows the public JWK.
const DB_NAME = "trigenys-sign";
const STORE = "keys";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    tx.onsuccess = () => resolve(tx.result ?? null);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function supportsEd25519() {
  return typeof crypto?.subtle?.generateKey === "function";
}

/** Returns the stored key pair for this signer identity (e-mail), or null. */
export async function loadKeyPair(identity) {
  return idbGet(`kp:${identity}`);
}

/** Generates a fresh non-extractable Ed25519 key pair and stores it. */
export async function createKeyPair(identity) {
  let pair;
  try {
    pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  } catch (e) {
    throw new Error("Ce navigateur ne sait pas générer de clé Ed25519. Utilisez Chrome, Edge, Safari ou Firefox récents.");
  }
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const record = { pair, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, createdAt: new Date().toISOString() };
  await idbSet(`kp:${identity}`, record);
  return record;
}

/** RFC 7638 thumbprint, hex — must match the server's keyFingerprint(). */
export async function fingerprintOf(publicJwk) {
  const canonical = JSON.stringify({ crv: publicJwk.crv, kty: publicJwk.kty, x: publicJwk.x });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Canonical JSON identical to the server implementation (sorted keys, no spaces). */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function signPayload(record, payload) {
  const message = new TextEncoder().encode(canonicalJson(payload));
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, record.pair.privateKey, message);
  return base64url(new Uint8Array(sig));
}

function base64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
