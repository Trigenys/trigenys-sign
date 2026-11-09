import type { Config } from "./config.js";
import { canonicalJson, newId, sha256Hex } from "./crypto.js";
import { Db, now, type Anchor, type AnchorKind } from "./db.js";
import * as ots from "./ots.js";
import * as tsa from "./tsa.js";

/**
 * Independent timestamping ("anchoring") of completed documents.
 *
 * Subject = canonical JSON of the document hash plus every signature; its SHA-256 is sent to
 *  - OpenTimestamps calendars (free, committed to a Bitcoin block within hours; upgraded by the sweep),
 *  - an RFC 3161 Time Stamping Authority (signed time, immediate).
 * Both proofs are stored as received so anyone can verify them with the standard tools.
 * Idempotent: one row per (document, kind); a pending or confirmed row is never redone, a failed
 * one is retried by the sweep. Existing completed documents are anchored retroactively by the sweep.
 */

export interface AnchorSubject {
  v: 1;
  documentId: string;
  documentSha256: string;
  signatures: Array<{ signerId: string; email: string; keyFingerprint: string; signedAt: string; signature: string }>;
}

export interface AnchorDetail {
  calendars?: string[];
  height?: number;
  blockHash?: string;
  serial?: string;
  policy?: string;
  error?: string;
}

export interface AnchorView {
  kind: AnchorKind;
  status: Anchor["status"];
  provider: string | null;
  digest: string;
  subject: AnchorSubject;
  createdAt: string;
  updatedAt: string;
  /** Time attested by the third party (block time or TSA genTime), once confirmed. */
  anchoredAt: string | null;
  detail: AnchorDetail;
}

export interface Logger {
  warn(msg: string): void;
}

const UPGRADE_RETRY_MS = 20 * 60_000;

export class Anchors {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    private readonly cfg: Config,
    private readonly db: Db,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: Logger = console,
  ) {}

  get enabled(): boolean {
    return this.cfg.anchors.enabled;
  }

  /** Canonical subject of a completed document, or null while signatures are missing. */
  subjectOf(documentId: string): AnchorSubject | null {
    const doc = this.db.get<{ id: string; sha256: string; status: string }>("SELECT id, sha256, status FROM documents WHERE id = ?", documentId);
    if (!doc || doc.status !== "completed") return null;
    const rows = this.db.all<{ id: string; email: string; signed_at: string | null; signature_b64: string | null; fingerprint: string | null }>(
      "SELECT s.id, u.email, s.signed_at, s.signature_b64, k.fingerprint FROM signers s JOIN users u ON u.id = s.user_id LEFT JOIN signing_keys k ON k.id = s.key_id WHERE s.document_id = ? ORDER BY s.id",
      documentId,
    );
    if (rows.length === 0 || rows.some((r) => !r.signed_at || !r.signature_b64 || !r.fingerprint)) return null;
    return {
      v: 1,
      documentId: doc.id,
      documentSha256: doc.sha256,
      signatures: rows.map((r) => ({ signerId: r.id, email: r.email, keyFingerprint: r.fingerprint!, signedAt: r.signed_at!, signature: r.signature_b64! })),
    };
  }

  static digestOf(subject: AnchorSubject): string {
    return sha256Hex(Buffer.from(canonicalJson(subject), "utf8"));
  }

  list(documentId: string): Anchor[] {
    return this.db.all<Anchor>("SELECT * FROM anchors WHERE document_id = ? ORDER BY kind", documentId);
  }

  view(documentId: string): AnchorView[] {
    return this.list(documentId).map((a) => ({
      kind: a.kind,
      status: a.status,
      provider: a.provider,
      digest: a.digest,
      subject: JSON.parse(a.subject_json) as AnchorSubject,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
      anchoredAt: a.anchored_at,
      detail: a.detail_json ? (JSON.parse(a.detail_json) as AnchorDetail) : {},
    }));
  }

  proof(documentId: string, kind: AnchorKind): { bytes: Buffer; extension: string; mime: string } | null {
    const a = this.db.get<Anchor>("SELECT * FROM anchors WHERE document_id = ? AND kind = ?", documentId, kind);
    if (!a?.proof) return null;
    return kind === "ots" ? { bytes: Buffer.from(a.proof), extension: "ots", mime: "application/vnd.opentimestamps.v1" } : { bytes: Buffer.from(a.proof), extension: "tsr", mime: "application/timestamp-reply" };
  }

  /** Anchor a completed document with every kind that is not already pending or confirmed. */
  async anchorDocument(documentId: string): Promise<AnchorView[]> {
    if (!this.enabled) return this.view(documentId);
    const subject = this.subjectOf(documentId);
    if (!subject) return this.view(documentId);
    const digest = Anchors.digestOf(subject);
    const existing = new Map(this.list(documentId).map((a) => [a.kind, a]));
    const todo: AnchorKind[] = (["ots", "tsa"] as AnchorKind[]).filter((k) => {
      const row = existing.get(k);
      return !row || row.status === "failed" || row.digest !== digest;
    });
    await Promise.all(todo.map((kind) => this.anchorOne(documentId, kind, digest, subject)));
    return this.view(documentId);
  }

  private async anchorOne(documentId: string, kind: AnchorKind, digest: string, subject: AnchorSubject): Promise<void> {
    const t = now();
    const base = { id: newId(), document_id: documentId, kind, digest, subject_json: canonicalJson(subject), created_at: t };
    try {
      if (kind === "ots") {
        const r = await ots.stamp(Buffer.from(digest, "hex"), this.cfg.anchors.calendars, this.fetchImpl);
        this.upsert({ ...base, provider: r.calendars.join(","), proof: ots.serializeProof(r.proof), status: "pending", detail_json: JSON.stringify({ calendars: r.calendars } satisfies AnchorDetail), confirmed_at: null, anchored_at: null });
      } else {
        const r = await tsa.requestTimestamp(Buffer.from(digest, "hex"), this.cfg.anchors.tsaUrls, this.fetchImpl);
        this.upsert({ ...base, provider: r.url, proof: r.token, status: "confirmed", detail_json: JSON.stringify({ serial: r.info.serial, policy: r.info.policy } satisfies AnchorDetail), confirmed_at: t, anchored_at: r.info.genTime });
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.log.warn(`[anchors] ${kind} ${documentId}: ${error}`);
      this.upsert({ ...base, provider: null, proof: null, status: "failed", detail_json: JSON.stringify({ error } satisfies AnchorDetail), confirmed_at: null, anchored_at: null });
    }
  }

  private upsert(a: Omit<Anchor, "updated_at">): void {
    this.db.run(
      `INSERT INTO anchors (id, document_id, kind, provider, digest, subject_json, proof, status, detail_json, created_at, updated_at, confirmed_at, anchored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(document_id, kind) DO UPDATE SET provider = excluded.provider, digest = excluded.digest, subject_json = excluded.subject_json, proof = excluded.proof,
         status = excluded.status, detail_json = excluded.detail_json, updated_at = excluded.updated_at, confirmed_at = excluded.confirmed_at, anchored_at = excluded.anchored_at`,
      a.id, a.document_id, a.kind, a.provider, a.digest, a.subject_json, a.proof, a.status, a.detail_json, a.created_at, now(), a.confirmed_at, a.anchored_at,
    );
  }

  /** Ask the calendars whether a pending OpenTimestamps proof reached Bitcoin; verify the block when it did. */
  async upgrade(documentId: string): Promise<AnchorView[]> {
    const a = this.db.get<Anchor>("SELECT * FROM anchors WHERE document_id = ? AND kind = 'ots' AND status = 'pending'", documentId);
    if (!a?.proof) return this.view(documentId);
    const detail: AnchorDetail = a.detail_json ? (JSON.parse(a.detail_json) as AnchorDetail) : {};
    let proofBytes: Buffer = Buffer.from(a.proof);
    let status: Anchor["status"] = "pending";
    let anchoredAt: string | null = null;
    try {
      const proof = ots.parseProof(proofBytes);
      const r = await ots.upgrade(proof, this.fetchImpl);
      if (r.changed) proofBytes = ots.serializeProof(proof);
      delete detail.error;
      if (r.bitcoin.length > 0) {
        const best = r.bitcoin.reduce((m, b) => (b.height < m.height ? b : m));
        detail.height = best.height;
        const check = await ots.checkBitcoinBlock(this.cfg.anchors.explorerUrl, best.height, best.merkleRoot, this.fetchImpl);
        if (!check.merkleMatches) throw new Error(`la racine de Merkle du bloc ${best.height} ne correspond pas à la preuve`);
        detail.blockHash = check.blockHash;
        status = "confirmed";
        anchoredAt = check.blockTime;
      }
    } catch (e) {
      detail.error = e instanceof Error ? e.message : String(e);
      this.log.warn(`[anchors] upgrade ${documentId}: ${detail.error}`);
    }
    const t = now();
    this.db.run("UPDATE anchors SET proof = ?, status = ?, detail_json = ?, updated_at = ?, confirmed_at = ?, anchored_at = ? WHERE id = ?", proofBytes, status, JSON.stringify(detail), t, status === "confirmed" ? t : null, anchoredAt, a.id);
    return this.view(documentId);
  }

  /** Anchor completed documents that lack proofs (retroactive, retries) and upgrade pending ones. */
  async sweep(limit = 20): Promise<{ anchored: number; upgraded: number }> {
    if (!this.enabled || this.sweeping) return { anchored: 0, upgraded: 0 };
    this.sweeping = true;
    try {
      const missing = this.db.all<{ id: string }>(
        `SELECT d.id FROM documents d WHERE d.status = 'completed'
           AND ((SELECT COUNT(*) FROM anchors a WHERE a.document_id = d.id AND a.status <> 'failed') < 2)
         ORDER BY d.completed_at LIMIT ?`,
        limit,
      );
      for (const d of missing) await this.anchorDocument(d.id);
      const cutoff = new Date(Date.now() - UPGRADE_RETRY_MS).toISOString();
      const pending = this.db.all<{ document_id: string }>("SELECT document_id FROM anchors WHERE kind = 'ots' AND status = 'pending' AND updated_at < ? ORDER BY updated_at LIMIT ?", cutoff, limit);
      for (const p of pending) await this.upgrade(p.document_id);
      return { anchored: missing.length, upgraded: pending.length };
    } finally {
      this.sweeping = false;
    }
  }

  /** Periodic sweep; the timer never keeps the process alive. */
  start(): void {
    if (!this.enabled || this.timer) return;
    const run = () => void this.sweep().catch((e: unknown) => this.log.warn(`[anchors] sweep: ${e instanceof Error ? e.message : String(e)}`));
    setTimeout(run, 15_000).unref();
    this.timer = setInterval(run, this.cfg.anchors.sweepMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
