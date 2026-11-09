import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { Db } from "../src/db.js";
import type { DeliveryResult, EmailMessage, Notifier, WhatsAppMessage } from "../src/notify.js";
import { Service } from "../src/service.js";
import { Anchors } from "../src/anchors.js";

export class FakeNotifier implements Notifier {
  emails: Array<{ kind: string; key: string; msg: EmailMessage }> = [];
  whatsapps: Array<{ kind: string; key: string; msg: WhatsAppMessage }> = [];
  async email(kind: string, key: string, msg: EmailMessage): Promise<DeliveryResult> {
    this.emails.push({ kind, key, msg });
    return { accepted: true };
  }
  async whatsapp(kind: string, key: string, msg: WhatsAppMessage): Promise<DeliveryResult> {
    this.whatsapps.push({ kind, key, msg });
    return { accepted: true };
  }
}

export function testEnv(overrides: Record<string, string> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsign-"));
  const env: Record<string, string> = {
    PORT: "0",
    PUBLIC_BASE_URL: "http://sign.test",
    DATA_DIR: dataDir,
    SESSION_SECRET: "0123456789abcdef0123456789abcdef",
    ALLOWED_EMAIL_DOMAINS: "trigenys.com",
    DEV_SHOW_LINKS: "1",
    ...overrides,
  };
  const cfg = loadConfig(env);
  const db = new Db(dataDir);
  const notifier = new FakeNotifier();
  // No network in tests: anchoring attempts fail fast and are recorded as such.
  const offline: typeof fetch = async () => { throw new Error("réseau désactivé dans les tests"); };
  const svc = new Service(cfg, db, notifier, new Anchors(cfg, db, offline, { warn() {} }));
  return { cfg, db, notifier, svc, dataDir };
}

/** Minimal valid one-page PDF. */
export const MINIMAL_PDF = Buffer.from(
  [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >> endobj",
    "xref",
    "0 4",
    "0000000000 65535 f ",
    "0000000009 00000 n ",
    "0000000058 00000 n ",
    "0000000115 00000 n ",
    "trailer << /Size 4 /Root 1 0 R >>",
    "startxref",
    "190",
    "%%EOF",
  ].join("\n"),
  "latin1",
);

export const linkToken = (link: string) => link.split("/s/")[1]!;
export const tick = () => new Promise((r) => setImmediate(r));
