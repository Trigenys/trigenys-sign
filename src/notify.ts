import type { Config } from "./config.js";
import type { Db } from "./db.js";
import { newId, notifyId } from "./crypto.js";
import { now } from "./db.js";

export interface EmailMessage {
  recipient: string;
  subject: string;
  html: string;
  text: string;
}
export interface WhatsAppMessage {
  recipient: string; // E.164
  text: string;
  link?: string;
  linkLabel?: string;
}

export type DeliveryResult = { accepted: true } | { accepted: false; retryable: boolean; reason: string };

export interface Notifier {
  email(kind: string, key: string, msg: EmailMessage): Promise<DeliveryResult>;
  whatsapp(kind: string, key: string, msg: WhatsAppMessage): Promise<DeliveryResult>;
}

export const E164 = /^\+[1-9]\d{6,14}$/;

export function maskRecipient(r: string): string {
  if (r.includes("@")) {
    const [u, d] = r.split("@");
    return `${u.slice(0, 2)}***@${d}`;
  }
  return `***${r.slice(-4)}`;
}

/**
 * Trigenys Notify client (contract V1):
 *   POST {base}/v1/dispatch/{project}/email            header x-notify-auth
 *   POST {base}/v1/dispatch/{project}/whatsapp-direct  header x-notify-auth
 * 202 accepted · 503 retry same envelope · 409 id reused with other content.
 * Falls back to console logging per channel when no key is configured.
 */
export class NotifyClient implements Notifier {
  constructor(
    private readonly cfg: Config,
    private readonly db: Db,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {}

  private record(channel: string, recipient: string, kind: string, status: string, detail?: string) {
    this.db.run(
      "INSERT INTO notifications (id, channel, recipient_hint, kind, status, detail, created_at) VALUES (?,?,?,?,?,?,?)",
      newId(),
      channel,
      maskRecipient(recipient),
      kind,
      status,
      detail ?? null,
      now(),
    );
  }

  private async dispatch(
    channel: "email" | "whatsapp-direct",
    key: string,
    kind: string,
    idKey: string,
    recipient: string,
    message: Record<string, unknown>,
  ): Promise<DeliveryResult> {
    const { baseUrl, project } = this.cfg.notify;
    if (!baseUrl || !key) {
      this.log(`[notify:${channel}:console] ${kind} -> ${maskRecipient(recipient)} ${JSON.stringify(message)}`);
      this.record(channel, recipient, kind, "console");
      return { accepted: true };
    }
    const occurredAt = new Date();
    const envelope = {
      version: 1,
      project,
      id: notifyId(project, channel, kind, idKey),
      occurredAt: occurredAt.toISOString(),
      expiresAt: new Date(occurredAt.getTime() + 23 * 3600 * 1000).toISOString(),
      recipient,
      message,
    };
    try {
      const res = await this.fetchImpl(`${baseUrl}/v1/dispatch/${encodeURIComponent(project)}/${channel}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-notify-auth": key },
        body: JSON.stringify(envelope),
      });
      if (res.status === 202) {
        this.record(channel, recipient, kind, "accepted");
        return { accepted: true };
      }
      const retryable = res.status === 503 || res.status === 429 || res.status >= 500;
      this.record(channel, recipient, kind, retryable ? "retry" : "rejected", `HTTP ${res.status}`);
      this.log(`[notify:${channel}] ${kind} -> ${maskRecipient(recipient)} refused: HTTP ${res.status}`);
      return { accepted: false, retryable, reason: `Notify HTTP ${res.status}` };
    } catch (e) {
      this.record(channel, recipient, kind, "retry", "network");
      this.log(`[notify:${channel}] ${kind} -> ${maskRecipient(recipient)} network error: ${(e as Error).message}`);
      return { accepted: false, retryable: true, reason: (e as Error).message };
    }
  }

  email(kind: string, key: string, msg: EmailMessage): Promise<DeliveryResult> {
    return this.dispatch("email", this.cfg.notify.emailKey, kind, key, msg.recipient, {
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    });
  }

  whatsapp(kind: string, key: string, msg: WhatsAppMessage): Promise<DeliveryResult> {
    if (!E164.test(msg.recipient)) {
      this.record("whatsapp-direct", msg.recipient, kind, "rejected", "not E.164");
      return Promise.resolve({ accepted: false, retryable: false, reason: "recipient is not E.164" });
    }
    const message: Record<string, unknown> = { text: msg.text.slice(0, 3000) };
    if (msg.link) message.link = msg.link;
    if (msg.linkLabel) message.linkLabel = msg.linkLabel;
    return this.dispatch("whatsapp-direct", this.cfg.notify.whatsappDirectKey, kind, key, msg.recipient, message);
  }
}
