import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from "pdf-lib";

const LOGO_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "assets", "logo.png");
let logoBytes: Uint8Array | null | undefined;
function loadLogo(): Uint8Array | null {
  if (logoBytes === undefined) {
    try { logoBytes = new Uint8Array(readFileSync(LOGO_PATH)); } catch { logoBytes = null; }
  }
  return logoBytes;
}

export interface SignatureEntry {
  name: string;
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
