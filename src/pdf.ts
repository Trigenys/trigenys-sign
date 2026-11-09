import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, degrees, rgb, type PDFPage, type PDFFont } from "pdf-lib";

const LOGO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "assets", "logo.png");
let logoBytes: Uint8Array | null | undefined;
function loadLogo(): Uint8Array | null {
  if (logoBytes === undefined) {
    try { logoBytes = new Uint8Array(readFileSync(LOGO_PATH)); } catch { logoBytes = null; }
  }
  return logoBytes;
}

/** Placement of a signature on the original document, as fractions of the displayed page (origin top-left). */
export interface SignatureField {
  page: number; // 1-based
  x: number;
  y: number;
  w: number;
  h: number;
}

export function parseField(v: unknown): SignatureField | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === "number" && Number.isFinite(o[k] as number) ? (o[k] as number) : NaN);
  const page = n("page"), x = n("x"), y = n("y"), w = n("w"), h = n("h");
  if (!Number.isInteger(page) || page < 1 || page > 5000) return null;
  if ([x, y, w, h].some((k) => Number.isNaN(k)) || w < 0.02 || h < 0.02 || x < 0 || y < 0 || x + w > 1.0001 || y + h > 1.0001) return null;
  const r = (k: number) => Math.round(k * 10000) / 10000;
  return { page, x: r(x), y: r(y), w: r(Math.min(w, 1 - x)), h: r(Math.min(h, 1 - y)) };
}

export interface SignatureEntry {
  name: string;
  field?: SignatureField | null;
  email: string;
  signedAt: string;
  keyFingerprint: string;
  signatureB64: string;
  signaturePng: string; // data URL
}

export interface Manifest {
  version: 1;
  tool: string;
  documentId: string;
  title: string;
  sha256: string;
  verifyUrl: string;
  signatures: Array<Omit<SignatureEntry, "signaturePng"> & { payload: unknown }>;
}

function hexToRgb(hex: string) {
  const h = hex.replace("#", "");
  return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(t, size) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Draws each signature image inside its field on the original pages. Fields are fractions of the page as
 * displayed (rotation applied, origin top-left); they are mapped back to the unrotated PDF user space.
 * Pages that no longer exist are skipped: the signature sheet remains the record of signing.
 */
async function placeSignatures(pdf: PDFDocument, entries: SignatureEntry[]): Promise<void> {
  const pages = pdf.getPages();
  for (const e of entries) {
    const f = e.field;
    if (!f || f.page > pages.length) continue;
    const page = pages[f.page - 1]!;
    let img;
    try {
      img = await pdf.embedPng(Buffer.from(e.signaturePng.split(",")[1] ?? "", "base64"));
    } catch {
      continue;
    }
    const { width: pw, height: ph } = page.getSize();
    const rot = ((page.getRotation().angle % 360) + 360) % 360;
    // Displayed size, then the box in displayed points with origin top-left.
    const [dw, dh] = rot === 90 || rot === 270 ? [ph, pw] : [pw, ph];
    const bx = f.x * dw, by = f.y * dh, bw = f.w * dw, bh = f.h * dh;
    const scale = Math.min(bw / img.width, bh / img.height);
    const iw = img.width * scale, ih = img.height * scale;
    // Centre horizontally, sit on the bottom of the box (where a pen signature lands on a line).
    const ix = bx + (bw - iw) / 2, iyTop = by + bh - ih;
    // Map displayed top-left (ix, iyTop) with size (iw, ih) to unrotated user space (origin bottom-left).
    let x: number, y: number, rotate = 0;
    switch (rot) {
      case 90: x = iyTop; y = ix; rotate = 90; x += ih; break;
      case 180: x = dw - ix; y = iyTop + ih; rotate = 180; break;
      case 270: x = dh - iyTop; y = dw - ix; rotate = 270; x -= ih; break;
      default: x = ix; y = dh - iyTop - ih;
    }
    page.drawImage(img, { x, y, width: iw, height: ih, rotate: degrees(rotate) });
  }
}

/**
 * Appends a "Signatures" page to the original PDF and attaches the JSON manifest.
 * The original bytes are never modified: verification always re-hashes the original file.
 */
export async function renderSignedPdf(
  original: Uint8Array,
  manifest: Manifest,
  entries: SignatureEntry[],
  brand: { name: string; navy: string; orange: string },
): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(original, { ignoreEncryption: true });
  await placeSignatures(pdf, entries);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const navy = hexToRgb(brand.navy);
  const orange = hexToRgb(brand.orange);
  const grey = rgb(0.4, 0.4, 0.4);

  const pageSize: [number, number] = [595.28, 841.89];
  let page: PDFPage = pdf.addPage(pageSize);
  const margin = 50;
  let y = pageSize[1] - margin;

  const logoPng = loadLogo();
  const logo = logoPng ? await pdf.embedPng(logoPng) : null;
  const header = () => {
    const bandH = 44;
    page.drawRectangle({ x: 0, y: pageSize[1] - bandH, width: pageSize[0], height: bandH, color: rgb(1, 1, 1) });
    page.drawRectangle({ x: 0, y: pageSize[1] - bandH - 3, width: pageSize[0], height: 3, color: orange });
    let tx = margin;
    if (logo) {
      const h = 28;
      const w = (logo.width / logo.height) * h;
      page.drawImage(logo, { x: margin, y: pageSize[1] - bandH + (bandH - h) / 2, width: w, height: h });
      tx = margin + w + 14;
    }
    page.drawText(`${brand.name} - Page de signatures`, { x: tx, y: pageSize[1] - 27, size: 11, font: bold, color: navy });
    y = pageSize[1] - bandH - 30;
  };
  header();

  page.drawText(manifest.title, { x: margin, y, size: 16, font: bold, color: navy });
  y -= 22;
  page.drawText(`Empreinte SHA-256 du document original :`, { x: margin, y, size: 9, font, color: grey });
  y -= 12;
  page.drawText(manifest.sha256.slice(0, 64), { x: margin, y, size: 8.5, font, color: navy });
  y -= 14;
  page.drawText(`Verification : ${manifest.verifyUrl}`, { x: margin, y, size: 9, font, color: orange });
  y -= 28;

  for (const e of entries) {
    const blockH = 110;
    if (y - blockH < margin) {
      page = pdf.addPage(pageSize);
      header();
    }
    page.drawRectangle({ x: margin, y: y - blockH + 10, width: pageSize[0] - 2 * margin, height: blockH, borderColor: rgb(0.85, 0.85, 0.85), borderWidth: 1 });
    try {
      const pngBytes = Buffer.from(e.signaturePng.split(",")[1] ?? "", "base64");
      const img = await pdf.embedPng(pngBytes);
      const scale = Math.min(150 / img.width, 70 / img.height);
      page.drawImage(img, { x: margin + 12, y: y - blockH + 28, width: img.width * scale, height: img.height * scale });
    } catch {
      page.drawText("(image de signature indisponible)", { x: margin + 12, y: y - 40, size: 8, font, color: grey });
    }
    const tx = margin + 180;
    let ty = y - 10;
    page.drawText(e.name, { x: tx, y: ty, size: 12, font: bold, color: navy });
    ty -= 15;
    page.drawText(e.email, { x: tx, y: ty, size: 9, font, color: grey });
    ty -= 14;
    page.drawText(`Signe le ${new Date(e.signedAt).toLocaleString("fr-FR", { timeZone: "Africa/Douala" })} (Douala)`, { x: tx, y: ty, size: 9, font, color: rgb(0.2, 0.2, 0.2) });
    ty -= 14;
    page.drawText(`Cle Ed25519 : ${e.keyFingerprint.slice(0, 32)}...`, { x: tx, y: ty, size: 8, font, color: grey });
    ty -= 12;
    for (const line of wrap(`Signature : ${e.signatureB64}`, font, 7, pageSize[0] - margin - tx - 10).slice(0, 2)) {
      page.drawText(line, { x: tx, y: ty, size: 7, font, color: grey });
      ty -= 9;
    }
    y -= blockH + 14;
  }

  await pdf.attach(Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), "trigenys-sign-manifest.json", {
    mimeType: "application/json",
    description: "Manifeste des signatures Trigenys Sign",
    creationDate: new Date(),
    modificationDate: new Date(),
  });
  pdf.setProducer(brand.name);
  return pdf.save();
}
