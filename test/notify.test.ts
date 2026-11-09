import assert from "node:assert/strict";
import { test } from "node:test";
import { NotifyClient } from "../src/notify.js";
import { testEnv } from "./helpers.js";

const CONFIGURED = { NOTIFY_BASE_URL: "https://notify.test", NOTIFY_EMAIL_INGEST_KEY: "ek", NOTIFY_WHATSAPP_DIRECT_INGEST_KEY: "wk" };

test("console fallback when Notify is not configured", async () => {
  const { cfg, db } = testEnv();
  const lines: string[] = [];
  const client = new NotifyClient(cfg, db, undefined, (l) => lines.push(l));
  const r = await client.email("test", "k1", { recipient: "alice@trigenys.com", subject: "S", html: "<b>h</b>", text: "t" });
  assert.deepEqual(r, { accepted: true });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes("alice@trigenys.com"), "recipient is masked in logs");
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM notifications WHERE status='console'")!.n, 1);
});

test("envelope matches Notify contract V1 and ids are idempotent", async () => {
  const { cfg, db } = testEnv(CONFIGURED);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(null, { status: 202 });
  }) as typeof fetch;
  const client = new NotifyClient(cfg, db, fetchImpl, () => {});

  await client.email("sign-request", "doc:alice", { recipient: "alice@trigenys.com", subject: "S", html: "h", text: "t" });
  await client.email("sign-request", "doc:alice", { recipient: "alice@trigenys.com", subject: "S", html: "h", text: "t" });
  await client.whatsapp("sign-request", "doc:alice", { recipient: "+237600000001", text: "hello", link: "https://x", linkLabel: "Ouvrir" });

  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.url, "https://notify.test/v1/dispatch/trigenys-sign/email");
  assert.equal(calls[2]!.url, "https://notify.test/v1/dispatch/trigenys-sign/whatsapp-direct");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["x-notify-auth"], "ek");
  assert.equal((calls[2]!.init.headers as Record<string, string>)["x-notify-auth"], "wk");
  const e0 = JSON.parse(calls[0]!.init.body as string);
  const e1 = JSON.parse(calls[1]!.init.body as string);
  const e2 = JSON.parse(calls[2]!.init.body as string);
  assert.equal(e0.version, 1);
  assert.equal(e0.project, "trigenys-sign");
  assert.match(e0.id, /^[0-9a-f]{64}$/);
  assert.equal(e0.id, e1.id, "same logical notification -> same id");
  assert.notEqual(e0.id, e2.id);
  assert.deepEqual(e0.message, { subject: "S", html: "h", text: "t" });
  assert.deepEqual(e2.message, { text: "hello", link: "https://x", linkLabel: "Ouvrir" });
  assert.ok(Date.parse(e0.expiresAt) - Date.parse(e0.occurredAt) <= 86400_000);
});

test("non-E.164 WhatsApp recipients are rejected locally; 503 is retryable", async () => {
  const { cfg, db } = testEnv(CONFIGURED);
  const fetchImpl = (async () => new Response(null, { status: 503 })) as typeof fetch;
  const client = new NotifyClient(cfg, db, fetchImpl, () => {});
  const bad = await client.whatsapp("x", "k", { recipient: "0612345678", text: "t" });
  assert.deepEqual(bad, { accepted: false, retryable: false, reason: "recipient is not E.164" });
  const r = await client.email("x", "k", { recipient: "a@b.c", subject: "s", html: "h", text: "t" });
  assert.equal(r.accepted, false);
  assert.equal((r as { retryable: boolean }).retryable, true);
});
