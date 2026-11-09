import qrcode from "qrcode-generator";

export interface QrOptions {
  /** Quiet zone in modules (QR spec recommends 4). */
  margin?: number;
  /** Error correction level; M is the usual trade-off for screen display. */
  ecc?: "L" | "M" | "Q" | "H";
  dark?: string;
  light?: string;
}

/**
 * Renders a QR code as a standalone SVG string (single path, viewBox in modules).
 * Type number 0 lets the encoder pick the smallest version that fits the data.
 */
export function qrSvg(text: string, opts: QrOptions = {}): string {
  const margin = opts.margin ?? 4;
  const qr = qrcode(0, opts.ecc ?? "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const size = n + margin * 2;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  const light = opts.light ?? "#fff";
  const dark = opts.dark ?? "#000";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${size}" height="${size}" fill="${light}"/><path d="${d}" fill="${dark}"/></svg>`
  );
}
