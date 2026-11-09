import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson, generateEd25519, keyFingerprint, signCookie, verifyCookie, verifyEd25519 } from "../src/crypto.js";

test("canonicalJson sorts keys recursively and is stable", () => {
  const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" } });
  const b = canonicalJson({ a: { c: "x", d: [3, { y: 2, z: 1 }] }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
});

test("Ed25519 round trip and tamper detection", () => {
  const k = generateEd25519();
  const msg = canonicalJson({ v: 1, hello: "world" });
  const sig = k.sign(msg);
  assert.equal(verifyEd25519(k.jwk, msg, sig), true);
  assert.equal(verifyEd25519(k.jwk, msg + " ", sig), false);
  assert.equal(verifyEd25519(generateEd25519().jwk, msg, sig), false);
  assert.equal(verifyEd25519(k.jwk, msg, "AAAA"), false);
});

test("key fingerprint is RFC 7638 thumbprint, 64 hex chars", () => {
  const k = generateEd25519();
  const fp = keyFingerprint(k.jwk);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(fp, keyFingerprint({ x: k.jwk.x, crv: "Ed25519", kty: "OKP" }));
});

test("signed cookies verify and reject tampering", () => {
  const secret = "secret-secret-secret-secret-secret";
  const c = signCookie(secret, "user-1");
  assert.equal(verifyCookie(secret, c), "user-1");
  assert.equal(verifyCookie(secret, c.replace("user-1", "user-2")), null);
  assert.equal(verifyCookie("other-secret-other-secret-other-s", c), null);
  assert.equal(verifyCookie(secret, undefined), null);
});
