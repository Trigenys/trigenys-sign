import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import { signCookie, verifyCookie } from "./crypto.js";
import { HttpError, MIME, Router, parseCookies, readBody, readJson, redirect, sendJson, setCookie, type Ctx } from "./http.js";
import type { Service } from "./service.js";

const WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web");

export function createServer(cfg: Config, svc: Service): http.Server {
  const secure = cfg.publicBaseUrl.startsWith("https://");
  const router = new Router();

  const currentUser = (ctx: Ctx) => {
    const uid = verifyCookie(cfg.sessionSecret, ctx.cookies.ts_session);
    return uid ? svc.getUser(uid) : undefined;
  };
  const requireUser = (ctx: Ctx) => {
    const u = currentUser(ctx);
    if (!u) throw new HttpError(401, "Connexion requise");
    return u;
  };
  const page = (name: string) => (ctx: Ctx) => serveFile(ctx, path.join(WEB_DIR, name));

  // Pages
  router.add("GET", "/", page("index.html"));
  router.add("GET", "/s/:token", page("sign.html"));
  router.add("GET", "/h/:code", page("handoff.html"));
  router.add("GET", "/verify/:id", page("verify.html"));
  router.add("GET", "/auth/:token", (ctx) => {
    const user = svc.consumeLogin(ctx.params.token!);
    setCookie(ctx.res, "ts_session", signCookie(cfg.sessionSecret, user.id), { maxAge: 30 * 86400, secure });
    redirect(ctx.res, "/");
  });

  // Public config
  router.add("GET", "/api/config", (ctx) => sendJson(ctx.res, 200, { brand: cfg.brand, whatsappEnabled: !!cfg.notify.whatsappDirectKey || !cfg.notify.baseUrl }));

  // Auth
  router.add("POST", "/api/auth/request", async (ctx) => {
    const body = await readJson(ctx.req);
    sendJson(ctx.res, 200, { ok: true, ...(await svc.requestLogin(body.email)) });
  });
  router.add("POST", "/api/auth/logout", (ctx) => {
    setCookie(ctx.res, "ts_session", "", { maxAge: 0, secure });
    sendJson(ctx.res, 200, { ok: true });
  });
  router.add("GET", "/api/me", (ctx) => {
    const u = currentUser(ctx);
    sendJson(ctx.res, 200, u ? { id: u.id, email: u.email, name: u.name, phone: u.phone } : null);
  });
  router.add("POST", "/api/me", async (ctx) => {
    const u = requireUser(ctx);
    const body = await readJson(ctx.req);
    const phone = body.phone === undefined ? undefined : svc.normalizePhone(body.phone);
    const user = svc.upsertUser({ email: u.email, name: typeof body.name === "string" ? body.name : undefined, phone });
    sendJson(ctx.res, 200, { id: user.id, email: user.email, name: user.name, phone: user.phone });
  });

  // Documents (owner)
  router.add("GET", "/api/documents", (ctx) => sendJson(ctx.res, 200, svc.listDocuments(requireUser(ctx))));
  router.add("GET", "/api/contacts", (ctx) => sendJson(ctx.res, 200, svc.listContacts(requireUser(ctx), ctx.url.searchParams.get("q") ?? "")));
  router.add("POST", "/api/documents", async (ctx) => {
    const owner = requireUser(ctx);
    const meta = ctx.req.headers["x-document-meta"];
    if (typeof meta !== "string") throw new HttpError(400, "En-tête X-Document-Meta manquant");
    let parsed: { title?: unknown; signers?: unknown };
    try {
      parsed = JSON.parse(Buffer.from(meta, "base64").toString("utf8"));
    } catch {
      throw new HttpError(400, "X-Document-Meta illisible");
    }
    const file = await readBody(ctx.req);
    const doc = svc.createDocument(owner, { title: parsed.title, signers: parsed.signers }, file);
    sendJson(ctx.res, 201, svc.documentView(doc));
  });
  router.add("GET", "/api/documents/:id", (ctx) => {
    const owner = requireUser(ctx);
    const doc = svc.getDocument(ctx.params.id!);
    if (doc.owner_id !== owner.id) throw new HttpError(403, "Accès refusé");
    sendJson(ctx.res, 200, svc.documentView(doc));
  });

  router.add("PUT", "/api/documents/:id/fields", async (ctx) => {
    const body = await readJson<{ fields?: unknown }>(ctx.req);
    sendJson(ctx.res, 200, svc.setFields(requireUser(ctx), ctx.params.id!, body.fields));
  });
  // Files: original is readable by owner or a signer (via token cookie); signed PDF is public (its id is unguessable).
  router.add("GET", "/api/documents/:id/original.pdf", (ctx) => {
    const doc = svc.getDocument(ctx.params.id!);
    const u = currentUser(ctx);
    const signerToken = verifyCookie(cfg.sessionSecret, ctx.cookies.ts_signer);
    const allowed = (u && u.id === doc.owner_id) || (signerToken && svc.resolveSignerToken(signerToken).doc.id === doc.id);
    if (!allowed) throw new HttpError(403, "Accès refusé");
    const buf = svc.originalPdf(doc.id);
    ctx.res.writeHead(200, { "content-type": "application/pdf", "content-length": buf.length, "content-disposition": `inline; filename="${safeName(doc.title)}.pdf"` });
    ctx.res.end(buf);
  });
  router.add("GET", "/api/documents/:id/signed.pdf", async (ctx) => {
    const doc = svc.getDocument(ctx.params.id!);
    const bytes = await svc.signedPdf(doc.id);
    ctx.res.writeHead(200, { "content-type": "application/pdf", "content-length": bytes.length, "content-disposition": `attachment; filename="${safeName(doc.title)}-signe.pdf"` });
    ctx.res.end(Buffer.from(bytes));
  });
  router.add("GET", "/api/verify/:id", (ctx) => sendJson(ctx.res, 200, svc.verify(ctx.params.id!)));

  // Signer side (token in URL; a cookie remembers it so the PDF viewer can load the file)
  router.add("GET", "/api/sign/:token/context", (ctx) => {
    const context = svc.signerContext(ctx.params.token!);
    setCookie(ctx.res, "ts_signer", signCookie(cfg.sessionSecret, ctx.params.token!), { maxAge: 86400, secure });
    sendJson(ctx.res, 200, context);
  });
  router.add("GET", "/api/sign/:token/status", (ctx) => sendJson(ctx.res, 200, svc.signerStatus(ctx.params.token!)));
  router.add("POST", "/api/sign/:token/key", async (ctx) => {
    const body = await readJson<{ publicKeyJwk: unknown; signaturePng?: unknown; strokes?: unknown; handoffId?: unknown }>(ctx.req);
    const key = svc.enrollKey(ctx.params.token!, body);
    sendJson(ctx.res, 201, { fingerprint: key.fingerprint, createdAt: key.created_at });
  });
  // Phone hand-off: the desktop creates/polls/cancels a code; the phone claims it and submits a drawing.
  router.add("POST", "/api/sign/:token/handoff", (ctx) => sendJson(ctx.res, 201, svc.createHandoff(ctx.params.token!)));
  router.add("GET", "/api/sign/:token/handoff/:id", (ctx) => sendJson(ctx.res, 200, svc.handoffStatus(ctx.params.token!, ctx.params.id!)));
  router.add("POST", "/api/sign/:token/handoff/:id/cancel", (ctx) => sendJson(ctx.res, 200, svc.cancelHandoff(ctx.params.token!, ctx.params.id!)));
  router.add("POST", "/api/handoff/:code/claim", async (ctx) => {
    const body = await readJson<{ claim?: unknown }>(ctx.req);
    sendJson(ctx.res, 200, svc.claimHandoff(ctx.params.code!, body.claim ?? null));
  });
  router.add("POST", "/api/handoff/:code/drawing", async (ctx) => {
    const body = await readJson<{ claim: unknown; signaturePng: unknown; strokes: unknown }>(ctx.req);
    sendJson(ctx.res, 200, svc.submitHandoffDrawing(ctx.params.code!, body));
  });
  router.add("POST", "/api/sign/:token", async (ctx) => {
    const body = await readJson<{ payload: unknown; signature: unknown }>(ctx.req);
    sendJson(ctx.res, 200, await svc.sign(ctx.params.token!, body));
  });

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", cfg.publicBaseUrl);
    const ctx: Ctx = { req, res, url, params: {}, cookies: parseCookies(req.headers.cookie) };
    try {
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "no-referrer");
      if (url.pathname.startsWith("/static/")) {
        return serveFile(ctx, path.join(WEB_DIR, url.pathname.slice("/static/".length)));
      }
      const m = router.match(req.method ?? "GET", url.pathname);
      if (!m) throw new HttpError(404, "Page introuvable");
      ctx.params = m.params;
      await m.handler(ctx);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (req.headers.accept?.includes("text/html") && !url.pathname.startsWith("/api/")) {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><title>${status}</title><body style="font-family:sans-serif;padding:40px;color:${cfg.brand.navy}"><h1>${status}</h1><p>${escapeHtml((e as Error).message)}</p><a href="/">Accueil</a>`);
      } else {
        sendJson(res, status, { error: status === 500 ? "Erreur interne" : (e as Error).message });
      }
    }
  });
}

function serveFile(ctx: Ctx, filePath: string): void {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(WEB_DIR) || !fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    throw new HttpError(404, "Fichier introuvable");
  }
  const ext = path.extname(resolved);
  ctx.res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": ext === ".html" ? "no-store" : "public, max-age=300" });
  fs.createReadStream(resolved).pipe(ctx.res);
}

const safeName = (s: string) => s.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 80) || "document";
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
