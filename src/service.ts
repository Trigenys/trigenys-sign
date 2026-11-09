import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { Db, now, type Document, type Handoff, type Signer, type SigningKey, type User } from "./db.js";
import { canonicalJson, isEd25519Jwk, keyFingerprint, newId, randomToken, sha256Hex, verifyEd25519, type Ed25519Jwk } from "./crypto.js";
import { HttpError } from "./http.js";
import { E164, type Notifier } from "./notify.js";
import * as msg from "./messages.js";
import { renderSignedPdf, type Manifest, type SignatureEntry } from "./pdf.js";
import { qrSvg } from "./qr.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SignerInput {
  name: string;
  email: string;
  phone?: string;
}

export interface SignPayload {
  v: 1;
  documentId: string;
  documentSha256: string;
  signerId: string;
  keyFingerprint: string;
  signedAt: string;
}

export class Service {
  constructor(
    readonly cfg: Config,
    readonly db: Db,
    readonly notifier: Notifier,
  ) {}

  // ---------- users & auth ----------

  normalizeEmail(email: unknown): string {
    const e = String(email ?? "").trim().toLowerCase();
    if (!EMAIL.test(e)) throw new HttpError(400, "Adresse e-mail invalide");
    return e;
  }

  normalizePhone(phone: unknown): string | null {
    const raw = String(phone ?? "").replace(/[\s().-]/g, "");
    if (!raw) return null;
    const p = raw.startsWith("00") ? `+${raw.slice(2)}` : raw;
    if (!E164.test(p)) throw new HttpError(400, `Numéro WhatsApp invalide (format international attendu, ex. +2376XXXXXXXX) : ${phone}`);
    return p;
  }

  upsertUser(input: { email: string; name?: string | null; phone?: string | null }): User {
    const existing = this.db.get<User>("SELECT * FROM users WHERE email = ?", input.email);
    if (existing) {
      const name = input.name?.trim() || existing.name;
      const phone = input.phone ?? existing.phone;
      if (name !== existing.name || phone !== existing.phone) {
        this.db.run("UPDATE users SET name = ?, phone = ? WHERE id = ?", name, phone, existing.id);
      }
      return { ...existing, name, phone };
    }
    const user: User = { id: newId(), email: input.email, name: input.name?.trim() || null, phone: input.phone ?? null, created_at: now() };
    this.db.run("INSERT INTO users (id,email,name,phone,created_at) VALUES (?,?,?,?,?)", user.id, user.email, user.name, user.phone, user.created_at);
    return user;
  }

  getUser(id: string): User | undefined {
    return this.db.get<User>("SELECT * FROM users WHERE id = ?", id);
  }

  canIssue(email: string): boolean {
    const domains = this.cfg.allowedEmailDomains;
    return domains.length === 0 || domains.includes(email.split("@")[1]!);
  }

  async requestLogin(rawEmail: unknown): Promise<{ link: string | null }> {
    const email = this.normalizeEmail(rawEmail);
    if (!this.canIssue(email)) throw new HttpError(403, "Cette adresse n'est pas autorisée à émettre des documents");
    const user = this.upsertUser({ email });
    const token = randomToken();
    this.db.run(
      "INSERT INTO magic_links (token_hash,user_id,expires_at) VALUES (?,?,?)",
      sha256Hex(token),
      user.id,
      new Date(Date.now() + 20 * 60_000).toISOString(),
    );
    const link = `${this.cfg.publicBaseUrl}/auth/${token}`;
    await this.notifier.email("login", `${user.id}:${token.slice(0, 8)}`, msg.loginMessage(this.cfg, email, link));
    return { link: this.cfg.devShowLinks ? link : null };
  }

  consumeLogin(token: string): User {
    const row = this.db.get<{ token_hash: string; user_id: string; expires_at: string; used_at: string | null }>(
      "SELECT * FROM magic_links WHERE token_hash = ?",
      sha256Hex(token),
    );
    if (!row || row.used_at || row.expires_at < now()) throw new HttpError(401, "Lien de connexion invalide ou expiré");
    this.db.run("UPDATE magic_links SET used_at = ? WHERE token_hash = ?", now(), row.token_hash);
    return this.getUser(row.user_id)!;
  }

  // ---------- documents ----------

  createDocument(owner: User, input: { title: unknown; signers: unknown }, file: Buffer): Document {
    const title = String(input.title ?? "").trim().slice(0, 200);
    if (!title) throw new HttpError(400, "Titre requis");
    if (!Array.isArray(input.signers) || input.signers.length === 0) throw new HttpError(400, "Au moins un signataire requis");
    if (input.signers.length > 50) throw new HttpError(400, "50 signataires maximum");
    if (file.subarray(0, 5).toString("latin1") !== "%PDF-") throw new HttpError(400, "Le fichier doit être un PDF");

    const signers: SignerInput[] = (input.signers as Array<Record<string, unknown>>).map((s) => ({
      name: String(s.name ?? "").trim().slice(0, 120),
      email: this.normalizeEmail(s.email),
      phone: this.normalizePhone(s.phone) ?? undefined,
    }));
    if (signers.some((s) => !s.name)) throw new HttpError(400, "Chaque signataire doit avoir un nom");
    if (new Set(signers.map((s) => s.email)).size !== signers.length) throw new HttpError(400, "Un signataire apparaît deux fois");

    const id = newId();
    const sha256 = sha256Hex(file);
    const filePath = path.join(this.cfg.dataDir, "files", `${id}.pdf`);
    fs.writeFileSync(filePath, file);

    const doc: Document = { id, owner_id: owner.id, title, file_path: filePath, sha256, size: file.length, status: "pending", created_at: now(), completed_at: null };
    const tokens: Array<{ signer: Signer; user: User; token: string }> = [];
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO documents (id,owner_id,title,file_path,sha256,size,status,created_at) VALUES (?,?,?,?,?,?,?,?)",
        doc.id, doc.owner_id, doc.title, doc.file_path, doc.sha256, doc.size, doc.status, doc.created_at,
      );
      signers.forEach((s, i) => {
        const user = this.upsertUser({ email: s.email, name: s.name, phone: s.phone ?? null });
        const token = randomToken();
        const signer: Signer = { id: newId(), document_id: id, user_id: user.id, token_hash: sha256Hex(token), position: i, signed_at: null, key_id: null, payload_json: null, signature_b64: null, notified_at: null };
        this.db.run(
          "INSERT INTO signers (id,document_id,user_id,token_hash,position) VALUES (?,?,?,?,?)",
          signer.id, signer.document_id, signer.user_id, signer.token_hash, signer.position,
        );
        tokens.push({ signer, user, token });
      });
    });
    // Notifications are sent after commit; failures are recorded, never block creation.
    void this.notifySigners(doc, owner, tokens);
    return doc;
  }

  private async notifySigners(doc: Document, owner: User, list: Array<{ signer: Signer; user: User; token: string }>) {
    const ownerName = owner.name || owner.email;
    for (const { signer, user, token } of list) {
      const link = `${this.cfg.publicBaseUrl}/s/${token}`;
      const key = `${signer.id}:invite`;
      await this.notifier.email("sign-request", key, msg.signRequestEmail(this.cfg, { email: user.email, signerName: user.name || user.email, ownerName, title: doc.title, link }));
      if (user.phone) {
        await this.notifier.whatsapp("sign-request", key, msg.signRequestWhatsApp({ phone: user.phone, signerName: user.name || user.email, ownerName, title: doc.title, link }));
      }
      this.db.run("UPDATE signers SET notified_at = ? WHERE id = ?", now(), signer.id);
    }
  }

  listDocuments(owner: User) {
    const docs = this.db.all<Document>("SELECT * FROM documents WHERE owner_id = ? ORDER BY created_at DESC", owner.id);
    return docs.map((d) => this.documentView(d));
  }

  /** Signers the owner has already sent documents to, most recently used first. */
  listContacts(owner: User, q: unknown = "", limit = 50): Array<{ name: string | null; email: string; phone: string | null; lastUsedAt: string }> {
    const needle = `%${String(q ?? "").trim().toLowerCase()}%`;
    return this.db.all(
      `SELECT u.name, u.email, u.phone, MAX(d.created_at) AS lastUsedAt
       FROM signers s JOIN documents d ON d.id = s.document_id JOIN users u ON u.id = s.user_id
       WHERE d.owner_id = ? AND u.id != ? AND (lower(coalesce(u.name, '')) LIKE ? OR lower(u.email) LIKE ?)
       GROUP BY u.id ORDER BY lastUsedAt DESC LIMIT ?`,
      owner.id, owner.id, needle, needle, Math.min(Math.max(Number(limit) || 50, 1), 200),
    );
  }

  getDocument(id: string): Document {
    const d = this.db.get<Document>("SELECT * FROM documents WHERE id = ?", id);
    if (!d) throw new HttpError(404, "Document introuvable");
    return d;
  }

  signersOf(docId: string): Array<Signer & { name: string | null; email: string; phone: string | null }> {
    return this.db.all(
      `SELECT s.*, u.name, u.email, u.phone FROM signers s JOIN users u ON u.id = s.user_id WHERE s.document_id = ? ORDER BY s.position`,
      docId,
    );
  }

  documentView(d: Document) {
    const signers = this.signersOf(d.id);
    const signed = signers.filter((s) => s.signed_at).length;
    return {
      id: d.id,
      title: d.title,
      sha256: d.sha256,
      size: d.size,
      status: d.status,
      createdAt: d.created_at,
      completedAt: d.completed_at,
      total: signers.length,
      signed,
      remaining: signers.length - signed,
      verifyUrl: `${this.cfg.publicBaseUrl}/verify/${d.id}`,
      signers: signers.map((s) => ({ id: s.id, name: s.name, email: s.email, hasPhone: !!s.phone, signedAt: s.signed_at, notifiedAt: s.notified_at })),
    };
  }

  // ---------- signer side ----------

  resolveSignerToken(token: string) {
    const signer = this.db.get<Signer>("SELECT * FROM signers WHERE token_hash = ?", sha256Hex(token));
    if (!signer) throw new HttpError(404, "Lien de signature invalide");
    const doc = this.getDocument(signer.document_id);
    const user = this.getUser(signer.user_id)!;
    const owner = this.getUser(doc.owner_id)!;
    return { signer, doc, user, owner };
  }

  activeKey(userId: string): SigningKey | undefined {
    return this.db.get<SigningKey>("SELECT * FROM signing_keys WHERE user_id = ? AND superseded_at IS NULL ORDER BY created_at DESC LIMIT 1", userId);
  }

  signerContext(token: string) {
    const { signer, doc, user, owner } = this.resolveSignerToken(token);
    const key = this.activeKey(user.id);
    return {
      signer: { id: signer.id, name: user.name, email: user.email, signedAt: signer.signed_at },
      document: this.documentView(doc),
      owner: { name: owner.name || owner.email },
      key: key ? { fingerprint: key.fingerprint, signaturePng: key.signature_png, strokes: JSON.parse(key.strokes_json) as unknown, createdAt: key.created_at } : null,
      payload: signer.signed_at ? null : this.payloadFor(signer, doc, key?.fingerprint ?? null),
    };
  }

  payloadFor(signer: Signer, doc: Document, fingerprint: string | null): SignPayload | null {
    if (!fingerprint) return null;
    return { v: 1, documentId: doc.id, documentSha256: doc.sha256, signerId: signer.id, keyFingerprint: fingerprint, signedAt: now() };
  }

  /** Validates a drawn signature (PNG data URL + normalized strokes) coming from a browser. */
  validateDrawing(body: { signaturePng: unknown; strokes: unknown }): { png: string; strokesJson: string } {
    const png = String(body.signaturePng ?? "");
    if (!png.startsWith("data:image/png;base64,") || png.length > 400_000) throw new HttpError(400, "Image de signature PNG attendue (max 300 Ko)");
    const strokes = Array.isArray(body.strokes) ? body.strokes : [];
    if (strokes.length === 0) throw new HttpError(400, "Dessinez votre signature avant de l'enregistrer");
    return { png, strokesJson: JSON.stringify(strokes).slice(0, 200_000) };
  }

  /**
   * Registers (or replaces) the signer's browser key. A replacement is allowed because the
   * signer reached this page through a link delivered to their own e-mail / WhatsApp.
   * Old keys are kept (superseded) so past signatures stay verifiable.
   * With `handoffId`, the drawing comes from a phone hand-off submitted for this signer.
   */
  enrollKey(token: string, body: { publicKeyJwk: unknown; signaturePng?: unknown; strokes?: unknown; handoffId?: unknown }): SigningKey {
    const { signer, user } = this.resolveSignerToken(token);
    if (!isEd25519Jwk(body.publicKeyJwk)) throw new HttpError(400, "Clé publique Ed25519 (JWK) attendue");
    let handoff: Handoff | undefined;
    let drawing: { png: string; strokesJson: string };
    if (body.handoffId !== undefined && body.handoffId !== null) {
      handoff = this.db.get<Handoff>("SELECT * FROM handoffs WHERE id = ? AND signer_id = ?", String(body.handoffId), signer.id);
      if (!handoff || !handoff.submitted_at || !handoff.signature_png) throw new HttpError(404, "Aucune signature reçue du téléphone pour ce code");
      if (handoff.consumed_at) throw new HttpError(409, "Cette signature a déjà été utilisée");
      drawing = { png: handoff.signature_png, strokesJson: handoff.strokes_json ?? "[]" };
    } else {
      drawing = this.validateDrawing({ signaturePng: body.signaturePng, strokes: body.strokes });
    }
    const fingerprint = keyFingerprint(body.publicKeyJwk);
    if (this.db.get("SELECT 1 FROM signing_keys WHERE fingerprint = ?", fingerprint)) throw new HttpError(409, "Cette clé est déjà enregistrée");
    const key: SigningKey = {
      id: newId(), user_id: user.id, public_key_jwk: JSON.stringify(body.publicKeyJwk), fingerprint,
      signature_png: drawing.png, strokes_json: drawing.strokesJson, created_at: now(), superseded_at: null,
    };
    this.db.transaction(() => {
      this.db.run("UPDATE signing_keys SET superseded_at = ? WHERE user_id = ? AND superseded_at IS NULL", key.created_at, user.id);
      this.db.run(
        "INSERT INTO signing_keys (id,user_id,public_key_jwk,fingerprint,signature_png,strokes_json,created_at) VALUES (?,?,?,?,?,?,?)",
        key.id, key.user_id, key.public_key_jwk, key.fingerprint, key.signature_png, key.strokes_json, key.created_at,
      );
      if (handoff) this.db.run("UPDATE handoffs SET consumed_at = ? WHERE id = ?", key.created_at, handoff.id);
    });
    return key;
  }

  /** Lightweight view polled by the desktop while the phone draws or after signing. */
  signerStatus(token: string) {
    const { signer, user } = this.resolveSignerToken(token);
    const key = this.activeKey(user.id);
    return { signedAt: signer.signed_at, keyFingerprint: key?.fingerprint ?? null };
  }

  // ---------- phone hand-off (QR) ----------
  // The desktop creates a short-lived code; the phone opens /h/<code>, draws and submits a PNG;
  // the desktop polls, then enrolls its own key with `handoffId`. The phone never sees the signer token.

  private handoffState(h: Handoff): "waiting" | "claimed" | "submitted" | "consumed" | "cancelled" | "expired" {
    if (h.consumed_at) return "consumed";
    if (h.cancelled_at) return "cancelled";
    if (h.submitted_at) return "submitted";
    if (Date.parse(h.expires_at) <= Date.now()) return "expired";
    return h.claimed_at ? "claimed" : "waiting";
  }

  private handoffView(h: Handoff) {
    const state = this.handoffState(h);
    return {
      id: h.id, state, expiresAt: h.expires_at, claimedAt: h.claimed_at, submittedAt: h.submitted_at,
      signaturePng: state === "submitted" ? h.signature_png : null,
      strokes: state === "submitted" && h.strokes_json ? (JSON.parse(h.strokes_json) as unknown) : null,
    };
  }

  createHandoff(token: string) {
    const { signer } = this.resolveSignerToken(token);
    if (signer.signed_at) throw new HttpError(409, "Vous avez déjà signé ce document");
    const at = now();
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const recent = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM handoffs WHERE signer_id = ? AND created_at > ?", signer.id, hourAgo)!.n;
    if (recent >= 20) throw new HttpError(429, "Trop de codes générés : réessayez dans quelques minutes");
    const code = randomToken(24);
    const h: Handoff = {
      id: newId(), signer_id: signer.id, code_hash: sha256Hex(code), claim_hash: null, created_at: at,
      expires_at: new Date(Date.now() + this.cfg.handoffTtlMinutes * 60_000).toISOString(),
      claimed_at: null, submitted_at: null, signature_png: null, strokes_json: null, consumed_at: null, cancelled_at: null,
    };
    this.db.transaction(() => {
      // One open code per signer; stale rows older than a day are purged (nothing in them is kept).
      this.db.run("UPDATE handoffs SET cancelled_at = ? WHERE signer_id = ? AND consumed_at IS NULL AND cancelled_at IS NULL", at, signer.id);
      this.db.run("DELETE FROM handoffs WHERE expires_at < ? AND consumed_at IS NULL", new Date(Date.now() - 86_400_000).toISOString());
      this.db.run(
        "INSERT INTO handoffs (id,signer_id,code_hash,created_at,expires_at) VALUES (?,?,?,?,?)",
        h.id, h.signer_id, h.code_hash, h.created_at, h.expires_at,
      );
    });
    const url = `${this.cfg.publicBaseUrl}/h/${code}`;
    return { id: h.id, url, qrSvg: qrSvg(url), expiresAt: h.expires_at, ttlSeconds: this.cfg.handoffTtlMinutes * 60 };
  }

  private ownHandoff(token: string, id: string): Handoff {
    const { signer } = this.resolveSignerToken(token);
    const h = this.db.get<Handoff>("SELECT * FROM handoffs WHERE id = ? AND signer_id = ?", id, signer.id);
    if (!h) throw new HttpError(404, "Code introuvable");
    return h;
  }

  handoffStatus(token: string, id: string) {
    return this.handoffView(this.ownHandoff(token, id));
  }

  cancelHandoff(token: string, id: string) {
    const h = this.ownHandoff(token, id);
    if (!h.cancelled_at && !h.consumed_at) this.db.run("UPDATE handoffs SET cancelled_at = ? WHERE id = ?", now(), h.id);
    return { ok: true };
  }

  private byCode(code: string): Handoff {
    const h = this.db.get<Handoff>("SELECT * FROM handoffs WHERE code_hash = ?", sha256Hex(String(code ?? "")));
    if (!h) throw new HttpError(404, "Ce code n'existe pas ou a été remplacé");
    const state = this.handoffState(h);
    if (state === "expired") throw new HttpError(410, "Ce code a expiré : générez-en un nouveau sur l'ordinateur");
    if (state === "cancelled") throw new HttpError(410, "Ce code a été annulé sur l'ordinateur");
    if (state === "submitted" || state === "consumed") throw new HttpError(409, "Une signature a déjà été envoyée avec ce code");
    return h;
  }

  /**
   * Phone side: open of /h/<code>. Returns a claim secret that must accompany the drawing.
   * Idempotent for a phone that already holds the secret (reload, prerender, duplicate tab):
   * presenting the current claim keeps it; otherwise a new one is issued and the previous is void.
   */
  claimHandoff(code: string, existing: unknown = null) {
    const h = this.byCode(code);
    const { doc, user } = this.signerOfHandoff(h);
    const view = { expiresAt: h.expires_at, signerName: user.name || user.email, documentTitle: doc.title };
    if (typeof existing === "string" && existing && h.claim_hash && sha256Hex(existing) === h.claim_hash) return { claim: existing, ...view };
    const claim = randomToken(24);
    this.db.run("UPDATE handoffs SET claimed_at = ?, claim_hash = ? WHERE id = ?", now(), sha256Hex(claim), h.id);
    return { claim, ...view };
  }

  /** Phone side: stores the drawing; the desktop picks it up by polling. */
  submitHandoffDrawing(code: string, body: { claim: unknown; signaturePng: unknown; strokes: unknown }) {
    const h = this.byCode(code);
    if (!h.claim_hash || sha256Hex(String(body.claim ?? "")) !== h.claim_hash) throw new HttpError(403, h.claim_hash ? "Ce code a été rouvert dans un autre onglet : rechargez cette page puis renvoyez votre signature" : "Ouvrez d'abord le code depuis votre téléphone");
    const d = this.validateDrawing(body);
    this.db.run("UPDATE handoffs SET submitted_at = ?, signature_png = ?, strokes_json = ? WHERE id = ? AND submitted_at IS NULL", now(), d.png, d.strokesJson, h.id);
    return { ok: true };
  }

  private signerOfHandoff(h: Handoff) {
    const signer = this.db.get<Signer>("SELECT * FROM signers WHERE id = ?", h.signer_id)!;
    return { signer, doc: this.getDocument(signer.document_id), user: this.getUser(signer.user_id)! };
  }

  async sign(token: string, body: { payload: unknown; signature: unknown }) {
    const { signer, doc, user, owner } = this.resolveSignerToken(token);
    if (signer.signed_at) throw new HttpError(409, "Vous avez déjà signé ce document");
    const key = this.activeKey(user.id);
    if (!key) throw new HttpError(400, "Aucune clé de signature enregistrée");
    const p = body.payload as Partial<SignPayload> | undefined;
    if (!p || p.v !== 1 || p.documentId !== doc.id || p.documentSha256 !== doc.sha256 || p.signerId !== signer.id || p.keyFingerprint !== key.fingerprint) {
      throw new HttpError(400, "Charge utile de signature incohérente avec le document");
    }
    const signedAt = Date.parse(String(p.signedAt));
    if (!Number.isFinite(signedAt) || Math.abs(Date.now() - signedAt) > 10 * 60_000) throw new HttpError(400, "Horodatage de signature invalide (±10 min)");
    const message = canonicalJson(p);
    const jwk = JSON.parse(key.public_key_jwk) as Ed25519Jwk;
    if (typeof body.signature !== "string" || !verifyEd25519(jwk, message, body.signature)) throw new HttpError(400, "Signature cryptographique invalide");

    const at = now();
    let completed = false;
    this.db.transaction(() => {
      this.db.run("UPDATE signers SET signed_at = ?, key_id = ?, payload_json = ?, signature_b64 = ? WHERE id = ? AND signed_at IS NULL", at, key.id, message, body.signature, signer.id);
      const remaining = this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM signers WHERE document_id = ? AND signed_at IS NULL", doc.id)!.n;
      if (remaining === 0) {
        completed = true;
        this.db.run("UPDATE documents SET status = 'completed', completed_at = ? WHERE id = ?", at, doc.id);
      }
    });
    const view = this.documentView(doc);
    void this.notifyProgress(doc, owner, user, view.remaining, view.total);
    return { signedAt: at, completed, remaining: view.remaining, total: view.total };
  }

  private async notifyProgress(doc: Document, owner: User, signerUser: User, remaining: number, total: number) {
    const link = `${this.cfg.publicBaseUrl}/#doc=${doc.id}`;
    const signerName = signerUser.name || signerUser.email;
    const key = `${doc.id}:${signerUser.id}:progress`;
    await this.notifier.email("progress", key, msg.progressEmail(this.cfg, { email: owner.email, ownerName: owner.name || owner.email, signerName, title: doc.title, remaining, total, link }));
    if (owner.phone) {
      await this.notifier.whatsapp("progress", key, msg.progressWhatsApp({ phone: owner.phone, signerName, title: doc.title, remaining, total, link }));
    }
  }

  // ---------- verification & export ----------

  verify(docId: string) {
    const doc = this.getDocument(docId);
    const file = fs.readFileSync(doc.file_path);
    const actualSha = sha256Hex(file);
    const signers = this.signersOf(doc.id);
    const results = signers.map((s) => {
      if (!s.signed_at || !s.key_id || !s.payload_json || !s.signature_b64) {
        return { name: s.name, email: s.email, signed: false as const, valid: null };
      }
      const key = this.db.get<SigningKey>("SELECT * FROM signing_keys WHERE id = ?", s.key_id)!;
      const payload = JSON.parse(s.payload_json) as SignPayload;
      const valid =
        payload.documentSha256 === actualSha &&
        payload.signerId === s.id &&
        payload.keyFingerprint === key.fingerprint &&
        verifyEd25519(JSON.parse(key.public_key_jwk) as Ed25519Jwk, canonicalJson(payload), s.signature_b64);
      return { name: s.name, email: s.email, signed: true as const, valid, signedAt: s.signed_at, keyFingerprint: key.fingerprint, payload, signature: s.signature_b64 };
    });
    return {
      document: { id: doc.id, title: doc.title, sha256: doc.sha256, status: doc.status, createdAt: doc.created_at, completedAt: doc.completed_at },
      fileIntact: actualSha === doc.sha256,
      allValid: results.every((r) => r.signed && r.valid),
      signatures: results,
    };
  }

  originalPdf(docId: string): Buffer {
    return fs.readFileSync(this.getDocument(docId).file_path);
  }

  async signedPdf(docId: string): Promise<Uint8Array> {
    const doc = this.getDocument(docId);
    const v = this.verify(docId);
    const entries: SignatureEntry[] = [];
    const manifest: Manifest = { version: 1, tool: this.cfg.brand.name, documentId: doc.id, title: doc.title, sha256: doc.sha256, verifyUrl: `${this.cfg.publicBaseUrl}/verify/${doc.id}`, signatures: [] };
    for (const s of v.signatures) {
      if (!s.signed) continue;
      const key = this.db.get<SigningKey>("SELECT * FROM signing_keys WHERE fingerprint = ?", s.keyFingerprint)!;
      entries.push({ name: s.name || s.email, email: s.email, signedAt: s.signedAt, keyFingerprint: s.keyFingerprint, signatureB64: s.signature, signaturePng: key.signature_png });
      manifest.signatures.push({ name: s.name || s.email, email: s.email, signedAt: s.signedAt, keyFingerprint: s.keyFingerprint, signatureB64: s.signature, payload: s.payload });
    }
    return renderSignedPdf(fs.readFileSync(doc.file_path), manifest, entries, this.cfg.brand);
  }
}
