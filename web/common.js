// Shared helpers: API calls, formatting, brand bootstrap.
export async function api(path, { method = "GET", body, headers = {}, raw = false } = {}) {
  const init = { method, headers: { ...headers }, credentials: "same-origin" };
  if (body !== undefined) {
    if (raw) init.body = body;
    else {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }
  const res = await fetch(path, init);
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `Erreur ${res.status}`);
  return data;
}

export const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }) : "";

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function notice(el, kind, html) {
  el.className = `notice ${kind}`;
  el.innerHTML = html;
  el.classList.remove("hidden");
}

export async function bootBrand() {
  try {
    const { brand } = await api("/api/config");
    const r = document.documentElement.style;
    r.setProperty("--navy", brand.navy);
    r.setProperty("--orange", brand.orange);
    r.setProperty("--offwhite", brand.offwhite);
    document.querySelectorAll("[data-brand-name]").forEach((n) => (n.textContent = brand.name));
    document.title = document.title.replace("Trigenys Sign", brand.name);
    return brand;
  } catch {
    return null;
  }
}
