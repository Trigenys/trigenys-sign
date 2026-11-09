// Signature pad (pointer events) + stroke replay animation.
export class SignaturePad {
  constructor(canvas, { color = "#102f52", width = 2.4 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.color = color;
    this.width = width;
    this.strokes = []; // [[{x,y,t}], ...] normalised to 0..1
    this.current = null;
    this.onChange = null;
    this.resize();
    window.addEventListener("resize", () => this.resize());
    canvas.addEventListener("pointerdown", (e) => this.start(e));
    canvas.addEventListener("pointermove", (e) => this.move(e));
    canvas.addEventListener("pointerup", (e) => this.end(e));
    canvas.addEventListener("pointerleave", (e) => this.end(e));
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.redraw();
  }

  point(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height, t: performance.now() };
  }

  start(e) {
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.current = [this.point(e)];
    this.strokes.push(this.current);
    this.canvas.parentElement?.classList.add("active");
  }

  move(e) {
    if (!this.current) return;
    e.preventDefault();
    this.current.push(this.point(e));
    this.redraw();
  }

  end() {
    if (!this.current) return;
    if (this.current.length < 2) this.strokes.pop();
    this.current = null;
    this.redraw();
    this.onChange?.(this.isEmpty());
  }

  clear() {
    this.strokes = [];
    this.current = null;
    this.redraw();
    this.canvas.parentElement?.classList.remove("active");
    this.onChange?.(true);
  }

  isEmpty() {
    return this.strokes.length === 0;
  }

  redraw() {
    const { width: w, height: h } = this.canvas.getBoundingClientRect();
    this.ctx.clearRect(0, 0, w, h);
    drawStrokes(this.ctx, this.strokes, w, h, this.color, this.width);
  }

  /** Transparent PNG cropped to the drawing, with padding. */
  toPng() {
    const pts = this.strokes.flat();
    if (!pts.length) return null;
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
    const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
    const rect = this.canvas.getBoundingClientRect();
    const scale = 2;
    const pad = 12;
    const w = Math.max(1, (maxX - minX) * rect.width) * scale + pad * 2;
    const h = Math.max(1, (maxY - minY) * rect.height) * scale + pad * 2;
    const off = document.createElement("canvas");
    off.width = Math.ceil(w);
    off.height = Math.ceil(h);
    const ctx = off.getContext("2d");
    const mapped = this.strokes.map((s) =>
      s.map((p) => ({ x: ((p.x - minX) * rect.width * scale + pad) / w, y: ((p.y - minY) * rect.height * scale + pad) / h, t: p.t })),
    );
    drawStrokes(ctx, mapped, w, h, this.color, this.width * scale);
    return off.toDataURL("image/png");
  }

  /** Strokes with relative timing, safe to store and replay. */
  serialize() {
    const t0 = this.strokes[0]?.[0]?.t ?? 0;
    return this.strokes.map((s) => s.map((p) => [round(p.x), round(p.y), Math.round(p.t - t0)]));
  }
}

const round = (v) => Math.round(v * 1000) / 1000;

export function drawStrokes(ctx, strokes, w, h, color, width) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  for (const s of strokes) {
    if (s.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(s[0].x * w, s[0].y * h);
    for (let i = 1; i < s.length; i++) {
      const p = s[i], q = s[i - 1];
      const speed = Math.hypot(p.x - q.x, p.y - q.y) * 100;
      ctx.lineWidth = Math.max(width * 0.55, width * (1.6 - Math.min(speed, 1.2)));
      ctx.lineTo(p.x * w, p.y * h);
    }
    ctx.stroke();
  }
}

/** Animates serialized strokes ([x,y,t] arrays) on a canvas; resolves when done. */
export function replayStrokes(canvas, serialized, { color = "#102f50", width = 2.4, duration = 1600 } = {}) {
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const strokes = serialized.map((s) => s.map(([x, y, t]) => ({ x, y, t })));
  const total = strokes.reduce((n, s) => n + s.length, 0);
  // Fit drawing into the canvas keeping aspect ratio.
  const pts = strokes.flat();
  const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
  const sw = Math.max(maxX - minX, 0.05), sh = Math.max(maxY - minY, 0.05);
  const scale = Math.min(0.8 / sw, 0.7 / sh);
  const ox = 0.5 - ((minX + maxX) / 2) * scale, oy = 0.5 - ((minY + maxY) / 2) * scale;
  const fitted = strokes.map((s) => s.map((p) => ({ x: p.x * scale + ox, y: p.y * scale + oy })));

  return new Promise((resolve) => {
    const start = performance.now();
    const frame = (now) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      let budget = Math.floor(eased * total);
      const partial = [];
      for (const s of fitted) {
        if (budget <= 0) break;
        partial.push(s.slice(0, budget));
        budget -= s.length;
      }
      ctx.clearRect(0, 0, rect.width, rect.height);
      drawStrokes(ctx, partial, rect.width, rect.height, color, width);
      if (progress < 1) requestAnimationFrame(frame);
      else resolve();
    };
    requestAnimationFrame(frame);
  });
}
