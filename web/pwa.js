// Installable web app: service worker registration and a discreet install prompt.
const DISMISS_KEY = "tsign.install.dismissed";
const DISMISS_DAYS = 30;

export function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => undefined));
}

const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;

function dismissed() {
  try {
    const t = Number(localStorage.getItem(DISMISS_KEY) || 0);
    return t && Date.now() - t < DISMISS_DAYS * 86_400_000;
  } catch {
    return false;
  }
}

function dismiss(el) {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* storage unavailable: the banner simply comes back next visit */
  }
  el.classList.add("hidden");
}

/**
 * Shows an install banner in `el` when the app can be added to the home screen:
 * a native prompt where the browser offers one, step-by-step instructions on iOS.
 */
export function installPrompt(el, appName = "l'application") {
  if (!el || isStandalone() || dismissed()) return;
  let deferred = null;
  const render = (body, action) => {
    el.innerHTML = `<div class="install"><div>${body}</div><div class="install-actions">${action ? `<button type="button" class="primary small" id="install-go">${action}</button>` : ""}<button type="button" class="ghost small" id="install-later">Plus tard</button></div></div>`;
    el.classList.remove("hidden");
    el.querySelector("#install-later").addEventListener("click", () => dismiss(el));
    el.querySelector("#install-go")?.addEventListener("click", async () => {
      if (!deferred) return;
      deferred.prompt();
      const { outcome } = await deferred.userChoice;
      deferred = null;
      if (outcome === "accepted") el.classList.add("hidden");
    });
  };
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    render(`Ajoutez ${appName} à votre écran d'accueil pour signer en un geste.`, "Installer");
  });
  window.addEventListener("appinstalled", () => el.classList.add("hidden"));
  if (isIos()) render(`Sur iPhone : touchez <strong>Partager</strong> puis <strong>Sur l'écran d'accueil</strong> pour installer ${appName}.`);
}
