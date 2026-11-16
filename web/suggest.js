// Pure placement heuristics for the "Signature" detection, kept DOM-free so they can be unit-tested.
// Input text items come from the pdf.js text layer, already converted to page fractions
// ({ page, str, left, right, baseline, lineH }, origin top-left).
//
// Rules, in order:
//   1. a signer whose name is printed next to a "Signature" label gets that label (the closing
//      signatures block names every party above or beside its line);
//   2. the remaining signers take the LAST labels of the document (last page, lowest lines first),
//      never a stray mention in the body such as "à la signature du contrat".

const ANCHOR = /^\s*signature(s)?(\s+(du|de|des|d'|d’|la|le|l'|l’|pour)\b[^_:.…]*)?\s*[:：]?[\s_.…]*$/i;
const STOP = new Set(["de", "du", "des", "la", "le", "les", "et", "mr", "mme", "mlle", "dr", "me"]);
const SAME_LINE = 0.01; // baseline tolerance (page fraction) for "same line"
const ABOVE = 0.12; // how far above a label a name may sit
const BELOW = 0.08; // how far below (name printed under the signing line)

export const normalize = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const nameTokens = (s) => normalize(s).split(" ").filter((t) => t.length >= 2 && !STOP.has(t));

export const isAnchor = (str) => ANCHOR.test(str || "");

/** Keeps the "Signature" labels, in reading order, with the column each one spans. */
export function findAnchors(items) {
  const anchors = items.filter((it) => isAnchor(it.str)).map((it) => ({ ...it }));
  anchors.sort((a, b) => a.page - b.page || Math.round(a.baseline / SAME_LINE) - Math.round(b.baseline / SAME_LINE) || a.left - b.left);
  for (const a of anchors) {
    const sameLine = anchors.filter((o) => o !== a && o.page === a.page && Math.abs(o.baseline - a.baseline) < SAME_LINE);
    const next = sameLine.map((o) => o.left).filter((l) => l > a.left).sort((p, q) => p - q)[0];
    a.columns = sameLine.length > 0;
    a.colLeft = sameLine.length ? Math.max(0, a.left - 0.02) : 0;
    a.colRight = sameLine.length ? (next ?? 1) - 0.02 : 1;
  }
  return anchors;
}

/** Text printed around a label, within its column: the party's name usually lives there. */
export function neighborhood(anchor, items) {
  return items.filter(
    (it) =>
      it !== anchor &&
      it.page === anchor.page &&
      it.right > anchor.colLeft &&
      it.left < anchor.colRight &&
      it.baseline >= anchor.baseline - ABOVE &&
      it.baseline <= anchor.baseline + BELOW &&
      !isAnchor(it.str),
  );
}

/** Share of a signer's name tokens found near the label (0..1). */
export function nameScore(signerName, anchor, items) {
  const want = nameTokens(signerName);
  if (!want.length) return 0;
  const have = new Set(neighborhood(anchor, items).flatMap((it) => nameTokens(it.str)));
  const hit = want.filter((t) => have.has(t)).length;
  return hit / want.length;
}

/**
 * Assigns one anchor per signer still lacking a field.
 * @param items  text items of the whole document (page fractions)
 * @param signers [{ key, name }]
 * @param taken  anchors already occupied (same object identity or same page/left/baseline)
 * @returns { assignment: Map<key, anchor>, anchors }
 */
export function assignAnchors(items, signers, taken = []) {
  const anchors = findAnchors(items);
  // A placed box sitting on or right under a label (same line band, overlapping columns) owns that label.
  const sameSpot = (a, t) => a.page === t.page && Math.abs(a.baseline - t.baseline) < 0.06 && t.left < a.right + 0.25 && (t.right ?? t.left + 0.2) > a.left - 0.02;
  const free = new Set(anchors.filter((a) => !taken.some((t) => sameSpot(a, t))));
  const pending = new Set(signers);
  const assignment = new Map();

  // 1. Names first: best scores win, ties go to the later label (closing block over body mentions).
  const pairs = [];
  for (const s of pending) for (const a of free) {
    const score = nameScore(s.name, a, items);
    if (score >= 0.5) pairs.push({ s, a, score });
  }
  pairs.sort((p, q) => q.score - p.score || q.a.page - p.a.page || q.a.baseline - p.a.baseline || p.a.left - q.a.left);
  for (const { s, a } of pairs) {
    if (!pending.has(s) || !free.has(a)) continue;
    assignment.set(s.key, a);
    pending.delete(s);
    free.delete(a);
  }

  // 2. Then the last labels of the document: last page, lowest line first, left to right within a line.
  const rest = [...free];
  const line = (a) => Math.round(a.baseline / SAME_LINE);
  rest.sort((a, b) => b.page - a.page || line(b) - line(a) || a.left - b.left);
  // Keep lines whole: a column block on one line is consumed left to right before moving up.
  for (const s of pending) {
    const a = rest.shift();
    if (!a) break;
    assignment.set(s.key, a);
  }
  return { assignment, anchors };
}
