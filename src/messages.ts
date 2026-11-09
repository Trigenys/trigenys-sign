import type { Config } from "./config.js";
import type { EmailMessage, WhatsAppMessage } from "./notify.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function layout(cfg: Config, title: string, bodyHtml: string, cta?: { href: string; label: string }): string {
  const { navy, orange, offwhite, name } = cfg.brand;
  return `<!doctype html><html lang="fr"><body style="margin:0;background:${offwhite};font-family:Helvetica,Arial,sans-serif;color:#1c1c1c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#ffffff;padding:16px 28px;border-bottom:3px solid ${orange}"><img src="${cfg.publicBaseUrl}/static/assets/logo.png" alt="Trigenys Group" width="152" height="48" style="display:block;height:48px;width:auto;border:0"></td></tr>
<tr><td style="background:${navy};padding:10px 28px;color:#ffffff;font-weight:bold;font-size:14px">${esc(name)}</td></tr>
<tr><td style="padding:28px;color:#1c1c1c;font-size:15px;line-height:1.5"><h1 style="margin:0 0 16px;font-size:20px;color:${navy}">${esc(title)}</h1><div style="color:#1c1c1c">${bodyHtml}</div>
${cta ? `<p style="margin:28px 0 8px"><a href="${cta.href}" style="background:${orange};color:#ffffff !important;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block">${esc(cta.label)}</a></p><p style="font-size:12px;color:#555">Ou copiez ce lien : <a href="${cta.href}" style="color:${navy}">${cta.href}</a></p>` : ""}
</td></tr>
<tr><td style="padding:14px 28px;font-size:11px;color:#555;background:#fafaf7">Ce lien est personnel. Ne le transférez pas. ${esc(name)} — Trigenys Group.</td></tr>
</table></td></tr></table></body></html>`;
}

export function loginMessage(cfg: Config, email: string, link: string): EmailMessage {
  return {
    recipient: email,
    subject: `${cfg.brand.name} — votre lien de connexion`,
    html: layout(cfg, "Connexion", `<p>Cliquez pour ouvrir ${esc(cfg.brand.name)}. Le lien expire dans 20 minutes.</p>`, { href: link, label: "Se connecter" }),
    text: `Connexion à ${cfg.brand.name} (expire dans 20 min) : ${link}`,
  };
}

export function signRequestEmail(cfg: Config, p: { email: string; signerName: string; ownerName: string; title: string; link: string }): EmailMessage {
  return {
    recipient: p.email,
    subject: `Signature demandée : ${p.title}`,
    html: layout(
      cfg,
      `Bonjour ${esc(p.signerName)},`,
      `<p><strong>${esc(p.ownerName)}</strong> vous demande de signer le document <strong>« ${esc(p.title)} »</strong>.</p>
<p>Lors de votre première visite, vous dessinerez votre signature et votre navigateur créera une clé de signature personnelle (Ed25519). Ensuite, un clic suffit.</p>`,
      { href: p.link, label: "Lire et signer" },
    ),
    text: `${p.ownerName} vous demande de signer « ${p.title} ». Lire et signer : ${p.link}`,
  };
}

export function signRequestWhatsApp(p: { phone: string; signerName: string; ownerName: string; title: string; link: string }): WhatsAppMessage {
  return {
    recipient: p.phone,
    text: `Bonjour ${p.signerName}, ${p.ownerName} vous demande de signer le document « ${p.title} » sur Trigenys Sign.`,
    link: p.link,
    linkLabel: "Lire et signer",
  };
}

export function progressEmail(cfg: Config, p: { email: string; ownerName: string; signerName: string; title: string; remaining: number; total: number; link: string }): EmailMessage {
  const done = p.remaining === 0;
  return {
    recipient: p.email,
    subject: done ? `Document entièrement signé : ${p.title}` : `${p.signerName} a signé « ${p.title} » (${p.remaining} restante${p.remaining > 1 ? "s" : ""})`,
    html: layout(
      cfg,
      done ? "Toutes les signatures sont réunies" : `${esc(p.signerName)} a signé`,
      `<p>Document : <strong>« ${esc(p.title)} »</strong></p><p>${p.total - p.remaining} signature(s) sur ${p.total}. ${done ? "Le PDF signé et son manifeste sont disponibles." : `Il manque encore <strong>${p.remaining}</strong> signature(s).`}</p>`,
      { href: p.link, label: done ? "Télécharger le PDF signé" : "Voir l'avancement" },
    ),
    text: `${p.signerName} a signé « ${p.title} ». ${p.total - p.remaining}/${p.total} signatures. ${done ? "Document complet." : `${p.remaining} manquante(s).`} ${p.link}`,
  };
}

export function progressWhatsApp(p: { phone: string; signerName: string; title: string; remaining: number; total: number; link: string }): WhatsAppMessage {
  const done = p.remaining === 0;
  return {
    recipient: p.phone,
    text: done
      ? `✅ « ${p.title} » est entièrement signé (${p.total}/${p.total}).`
      : `✍️ ${p.signerName} a signé « ${p.title} » : ${p.total - p.remaining}/${p.total}, encore ${p.remaining} signature(s) manquante(s).`,
    link: p.link,
    linkLabel: done ? "Télécharger" : "Voir l'avancement",
  };
}
