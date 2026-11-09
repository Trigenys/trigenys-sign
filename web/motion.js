// Small motion helpers shared by the pages. Every effect degrades to an instant change when the
// user prefers reduced motion or when the Web Animations API is missing.
const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
export const reduced = () => !!mq?.matches;

const EASE = "cubic-bezier(.32,.72,0,1)";
const canAnimate = (el) => typeof el.animate === "function" && !reduced();

/** Fades and lifts an element in. Resolves when finished. */
export function enter(el, { delay = 0, y = 10, duration = 320 } = {}) {
  el.classList.remove("hidden");
  if (!canAnimate(el)) return Promise.resolve();
  const a = el.animate(
    [{ opacity: 0, transform: `translateY(${y}px)` }, { opacity: 1, transform: "none" }],
    { duration, delay, easing: EASE, fill: "backwards" },
  );
  return a.finished.catch(() => {});
}

/** Fades an element out, then hides it. Resolves when finished. */
export function leave(el, { duration = 180 } = {}) {
  if (el.classList.contains("hidden")) return Promise.resolve();
  if (!canAnimate(el)) {
    el.classList.add("hidden");
    return Promise.resolve();
  }
  const a = el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-6px)" }], { duration, easing: "ease-in", fill: "forwards" });
  return a.finished.catch(() => {}).then(() => {
    el.classList.add("hidden");
    a.cancel();
  });
}

/** Cross-fades between steps: hides every element of `all` except `to`, which enters. */
export async function swapStep(all, to) {
  const out = all.filter((el) => el !== to && !el.classList.contains("hidden"));
  await Promise.all(out.map((el) => leave(el)));
  if (to && to.classList.contains("hidden")) await enter(to);
}

/** Pulses an element once (used for "received" moments). */
export function pop(el) {
  if (!canAnimate(el)) return Promise.resolve();
  return el.animate([{ transform: "scale(0.96)", opacity: 0.6 }, { transform: "scale(1.015)", opacity: 1 }, { transform: "none" }], { duration: 420, easing: EASE }).finished.catch(() => {});
}
