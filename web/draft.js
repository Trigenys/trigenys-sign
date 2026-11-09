// Draft of the "Nouveau document" form, kept in this browser's IndexedDB per account.
// Survives reloads, updates and closed tabs. The PDF is stored as a Blob; nothing leaves the device.
const DB_NAME = "trigenys-sign-drafts";
const STORE = "drafts";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req?.result ?? null);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const loadDraft = (owner) => tx("readonly", (s) => s.get(owner)).catch(() => null);
export const saveDraft = (owner, draft) => tx("readwrite", (s) => s.put({ ...draft, savedAt: Date.now() }, owner)).catch(() => {});
export const clearDraft = (owner) => tx("readwrite", (s) => s.delete(owner)).catch(() => {});

/** True when the draft holds something worth restoring. */
export const hasContent = (d) => !!d && (!!d.title || !!d.file || (d.signers || []).some((s) => s.name || s.email || s.phone));

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
