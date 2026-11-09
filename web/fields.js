// Signature placement: renders the PDF pages and lets the owner put one box per signer where the
// signature must land. Boxes are stored as fractions of the displayed page (origin top-left), so they
// survive any zoom and are mapped to PDF points by the server. "Signature" mentions found in the text
// layer are used to suggest positions.
const PDFJS = "/static/vendor/pdfjs/pdf.min.mjs";
const WORKER = "/static/vendor/pdfjs/pdf.worker.min.mjs";
const DEFAULT_W = 0.2;
const DEFAULT_H = 0.075;
const ANCHOR = /^\s*signature(\s+(du|de|des|d'|la|le|l')\b.*)?\s*:?\s*$/i;
const HUES = [340, 210, 150, 30, 270, 190, 60, 0];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class FieldPlacer {
  constructor(stage, { onChange } = {}) {
    this.stage = stage;
    this.onChange = onChange || (() => {});
    this.signers = []; // [{ key, name }]
    this.fields = {}; // key -> { page, x, y, w, h } | undefined
    this.armed = null; // key whose box is placed on the next page click
    this.doc = null;
    this.pages = []; // [{ el, overlay, vw, vh }]
    this.anchors = null; // lazily extracted text anchors
    this.loadId = 0;
    this.stage.classList.add("fp");
    this.stage.addEventListener("click", (e) => this.onStageClick(e));
  }

  /** source: { data: ArrayBuffer } or { url } */
  async load(source) {
    const id = ++this.loadId;
    this.stage.innerHTML = "";
    this.pages = [];
    this.anchors = null;
    this.doc = null;
    const pdfjs = await import(PDFJS);
    pdfjs.GlobalWorkerOptions.workerSrc = WORKER;
    const doc = await pdfjs.getDocument(source.data ? { data: source.data } : { url: source.url, withCredentials: true }).promise;
    if (id !== this.loadId) return;
    this.doc = doc;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      if (id !== this.loadId) return;
      const base = page.getViewport({ scale: 1 });
      const el = document.createElement("div");
      el.className = "fp-page";
      el.dataset.page = String(i);
      el.style.aspectRatio = `${base.width} / ${base.height}`;
      const canvas = document.createElement("canvas");
      const overlay = document.createElement("div");
      overlay.className = "fp-overlay";
      el.append(canvas, overlay);
      this.stage.appendChild(el);
      const cssWidth = el.clientWidth || this.stage.clientWidth || 600;
      const viewport = page.getViewport({ scale: (cssWidth / base.width) * dpr });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.setAttribute("aria-label", `Page ${i}`);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      this.pages.push({ el, overlay, page, base });
    }
    this.render();
  }

  setSigners(signers) {
    this.signers = signers.map((s, i) => ({ key: String(s.key), name: s.name || `Signataire ${i + 1}`, hue: HUES[i % HUES.length] }));
    for (const k of Object.keys(this.fields)) if (!this.signers.some((s) => s.key === k)) delete this.fields[k];
    this.render();
  }

  setFields(fields) {
    this.fields = {};
    for (const [k, f] of Object.entries(fields || {})) if (f) this.fields[String(k)] = { ...f };
    this.render();
  }

  getFields() {
    const out = {};
    for (const s of this.signers) out[s.key] = this.fields[s.key] ? { ...this.fields[s.key] } : null;
    return out;
  }

  arm(key) {
    this.armed = this.armed === key ? null : key;
    this.stage.classList.toggle("arming", !!this.armed);
    this.onChange({ armed: this.armed });
  }

  clear(key) {
    if (!this.fields[key]) return;
    delete this.fields[key];
    this.render();
    this.onChange({});
  }

  /** Reads the text layer once and returns "Signature" anchors as boxes in page fractions, reading order. */
  async findAnchors() {
    if (this.anchors) return this.anchors;
    const out = [];
    for (const { page, base } of this.pages) {
      const text = await page.getTextContent();
      for (const item of text.items) {
        if (!item.str || !ANCHOR.test(item.str)) continue;
        const [x0, y0] = base.convertToViewportPoint(item.transform[4], item.transform[5]);
        const h = Math.hypot(item.transform[2], item.transform[3]) || item.height || 10;
        out.push({ page: Number(page.pageNumber), left: x0 / base.width, right: (x0 + item.width) / base.width, baseline: y0 / base.height, lineH: h / base.height });
      }
    }
    out.sort((a, b) => a.page - b.page || Math.round(a.baseline * 50) - Math.round(b.baseline * 50) || a.left - b.left);
    this.anchors = out;
    return out;
  }

  /** Suggests a box for every signer without one, following the "Signature" mentions in document order. */
  async suggest() {
    const anchors = await this.findAnchors();
    const used = new Set(Object.values(this.fields).map((f) => `${f.page}:${f.x.toFixed(2)}:${f.y.toFixed(2)}`));
    let i = 0;
    let changed = false;
    for (const s of this.signers) {
      if (this.fields[s.key]) continue;
      while (i < anchors.length) {
        const a = anchors[i++];
        const box = this.boxFromAnchor(a);
        const sig = `${box.page}:${box.x.toFixed(2)}:${box.y.toFixed(2)}`;
        if (used.has(sig)) continue;
        used.add(sig);
        this.fields[s.key] = box;
        changed = true;
        break;
      }
    }
    this.render();
    if (changed) this.onChange({});
    return anchors.length;
  }

  boxFromAnchor(a) {
    const h = DEFAULT_H;
    // Labels sharing the baseline mean a column layout: the signature goes under its label, within the column.
    const sameLine = (this.anchors || []).filter((o) => o !== a && o.page === a.page && Math.abs(o.baseline - a.baseline) < 0.01);
    if (sameLine.length) {
      const next = sameLine.map((o) => o.left).filter((l) => l > a.left).sort((p, q) => p - q)[0];
      const colW = (next ?? 0.96) - a.left - 0.02;
      return this.fit({ page: a.page, x: a.left, y: a.baseline + 0.004, w: Math.min(DEFAULT_W, colW), h });
    }
    const w = DEFAULT_W;
    // Single label on its line: to the right of it when it fits, else just below it.
    if (a.right + 0.01 + w <= 0.98) return this.fit({ page: a.page, x: a.right + 0.01, y: a.baseline - h + a.lineH * 0.6, w, h });
    return this.fit({ page: a.page, x: a.left, y: a.baseline + 0.004, w, h });
  }

  fit(f) {
    const w = clamp(f.w, 0.05, 1), h = clamp(f.h, 0.03, 1);
    return { page: f.page, x: clamp(f.x, 0, 1 - w), y: clamp(f.y, 0, 1 - h), w, h };
  }

  onStageClick(e) {
    if (!this.armed || e.target.closest(".fp-box")) return;
    const pageEl = e.target.closest(".fp-page");
    if (!pageEl) return;
    const r = pageEl.getBoundingClientRect();
    const key = this.armed;
    this.fields[key] = this.fit({ page: Number(pageEl.dataset.page), x: (e.clientX - r.left) / r.width - DEFAULT_W / 2, y: (e.clientY - r.top) / r.height - DEFAULT_H / 2, w: DEFAULT_W, h: DEFAULT_H });
    this.armed = null;
    this.stage.classList.remove("arming");
    this.render();
    this.onChange({ placed: key });
  }

  render() {
    for (const p of this.pages) p.overlay.innerHTML = "";
    for (const s of this.signers) {
      const f = this.fields[s.key];
      if (!f) continue;
      const p = this.pages[f.page - 1];
      if (!p) continue;
      const box = document.createElement("div");
      box.className = "fp-box";
      box.style.setProperty("--fp-h", s.hue);
      box.style.left = `${f.x * 100}%`;
      box.style.top = `${f.y * 100}%`;
      box.style.width = `${f.w * 100}%`;
      box.style.height = `${f.h * 100}%`;
      box.dataset.key = s.key;
      box.title = `${s.name} — glissez pour déplacer`;
      box.innerHTML = `<span class="fp-label"></span><button type="button" class="fp-remove" aria-label="Retirer">✕</button><span class="fp-handle" aria-hidden="true"></span>`;
      box.querySelector(".fp-label").textContent = s.name;
      box.querySelector(".fp-remove").addEventListener("click", (e) => { e.stopPropagation(); this.clear(s.key); });
      this.drag(box, p, s.key);
      p.overlay.appendChild(box);
    }
  }

  drag(box, p, key) {
    box.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest(".fp-remove")) return;
      e.preventDefault();
      const resizing = e.target.classList.contains("fp-handle");
      const r = p.el.getBoundingClientRect();
      const start = { x: e.clientX, y: e.clientY, f: { ...this.fields[key] } };
      box.setPointerCapture(e.pointerId);
      box.classList.add("moving");
      const move = (ev) => {
        const dx = (ev.clientX - start.x) / r.width, dy = (ev.clientY - start.y) / r.height;
        const f = start.f;
        this.fields[key] = resizing
          ? this.fit({ page: f.page, x: f.x, y: f.y, w: f.w + dx, h: f.h + dy })
          : this.fit({ page: f.page, x: f.x + dx, y: f.y + dy, w: f.w, h: f.h });
        const n = this.fields[key];
        box.style.left = `${n.x * 100}%`; box.style.top = `${n.y * 100}%`; box.style.width = `${n.w * 100}%`; box.style.height = `${n.h * 100}%`;
      };
      const up = () => {
        box.removeEventListener("pointermove", move);
        box.removeEventListener("pointerup", up);
        box.removeEventListener("pointercancel", up);
        box.classList.remove("moving");
        this.onChange({ moved: key });
      };
      box.addEventListener("pointermove", move);
      box.addEventListener("pointerup", up);
      box.addEventListener("pointercancel", up);
    });
  }
}

/** Legend with one chip per signer: shows placed / to place, arms placement on click. */
export function renderLegend(container, placer) {
  container.innerHTML = "";
  const fields = placer.getFields();
  for (const s of placer.signers) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `fp-chip${fields[s.key] ? " placed" : ""}${placer.armed === s.key ? " armed" : ""}`;
    chip.style.setProperty("--fp-h", s.hue);
    chip.dataset.key = s.key;
    const f = fields[s.key];
    chip.innerHTML = `<i></i><span></span><small>${f ? `page ${f.page}` : placer.armed === s.key ? "cliquez sur la page" : "à placer"}</small>`;
    chip.querySelector("span").textContent = s.name;
    chip.addEventListener("click", () => placer.arm(s.key));
    container.appendChild(chip);
  }
}
