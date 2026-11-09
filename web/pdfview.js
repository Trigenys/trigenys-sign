// Renders a PDF into a container with pdf.js (self-hosted under /static/vendor/pdfjs/).
// Pages render lazily as they scroll into view; on failure, the container shows a link to the file.
const PDFJS = "/static/vendor/pdfjs/pdf.min.mjs";
const WORKER = "/static/vendor/pdfjs/pdf.worker.min.mjs";

export async function renderPdf(container, url, { maxDpr = 2 } = {}) {
  container.innerHTML = "";
  const pages = document.createElement("div");
  pages.className = "doc-pages";
  container.appendChild(pages);
  try {
    const pdfjs = await import(PDFJS);
    pdfjs.GlobalWorkerOptions.workerSrc = WORKER;
    const doc = await pdfjs.getDocument({ url, withCredentials: true }).promise;
    const first = await doc.getPage(1);
    const base = first.getViewport({ scale: 1 });
    const slots = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const slot = document.createElement("div");
      slot.className = "placeholder";
      slot.style.aspectRatio = `${base.width} / ${base.height}`;
      slot.dataset.page = String(i);
      pages.appendChild(slot);
      slots.push(slot);
    }
    const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
    const draw = async (slot) => {
      if (slot.dataset.done) return;
      slot.dataset.done = "1";
      const page = await doc.getPage(Number(slot.dataset.page));
      const cssWidth = slot.clientWidth || pages.clientWidth || 360;
      const viewport = page.getViewport({ scale: (cssWidth / page.getViewport({ scale: 1 }).width) * dpr });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      canvas.setAttribute("aria-label", `Page ${slot.dataset.page}`);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      slot.replaceWith(canvas);
    };
    if (typeof IntersectionObserver === "function") {
      const io = new IntersectionObserver(
        (entries) => entries.forEach((e) => e.isIntersecting && (io.unobserve(e.target), draw(e.target))),
        { rootMargin: "600px 0px" },
      );
      slots.forEach((s) => io.observe(s));
    } else {
      for (const s of slots) await draw(s);
    }
    return doc.numPages;
  } catch (err) {
    const fb = document.createElement("div");
    fb.className = "doc-fallback";
    fb.innerHTML = `<p>L'aperçu n'a pas pu être affiché ici.</p><a class="btn ghost" target="_blank" rel="noopener"></a>`;
    const a = fb.querySelector("a");
    a.href = url;
    a.textContent = "Ouvrir le PDF";
    container.innerHTML = "";
    container.appendChild(fb);
    throw err;
  }
}
