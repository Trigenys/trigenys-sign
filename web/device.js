// Device heuristics for the signing flow.
// A touch-first device draws the signature on the spot; a pointer device hands the drawing off to a phone,
// unless the user asked to draw here (`?draw=here`, remembered for this browser).
const DRAW_HERE_KEY = "ts.drawHere";

export function hasCoarsePointer() {
  return !!window.matchMedia?.("(pointer: coarse)").matches;
}

export function isCompact() {
  return window.innerWidth <= 1023;
}

export function prefersDrawHere() {
  const q = new URLSearchParams(location.search).get("draw");
  if (q === "here") {
    try { localStorage.setItem(DRAW_HERE_KEY, "1"); } catch { /* storage unavailable */ }
    return true;
  }
  if (q === "phone") {
    try { localStorage.removeItem(DRAW_HERE_KEY); } catch { /* storage unavailable */ }
    return false;
  }
  try { return localStorage.getItem(DRAW_HERE_KEY) === "1"; } catch { return false; }
}

export function rememberDrawHere(value) {
  try {
    if (value) localStorage.setItem(DRAW_HERE_KEY, "1");
    else localStorage.removeItem(DRAW_HERE_KEY);
  } catch { /* storage unavailable */ }
}

/** True when the signature should be drawn in this browser rather than on a phone. */
export function canDrawHere() {
  return hasCoarsePointer() || prefersDrawHere();
}
