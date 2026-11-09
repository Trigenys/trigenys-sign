import path from "node:path";

export interface Config {
  port: number;
  publicBaseUrl: string;
  dataDir: string;
  sessionSecret: string;
  allowedEmailDomains: string[];
  brand: { name: string; navy: string; orange: string; offwhite: string };
  notify: {
    baseUrl: string;
    project: string;
    emailKey: string;
    whatsappDirectKey: string;
  };
  devShowLinks: boolean;
  /** Lifetime of a phone hand-off code (QR). */
  handoffTtlMinutes: number;
  /** Independent timestamping of completed documents (OpenTimestamps + RFC 3161). */
  anchors: {
    enabled: boolean;
    calendars: string[];
    tsaUrls: string[];
    explorerUrl: string;
    sweepMinutes: number;
  };
}

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export function loadConfig(e: NodeJS.ProcessEnv = process.env): Config {
  const prev = process.env;
  process.env = e;
  try {
    const secret = env("SESSION_SECRET");
    if (secret.length < 32) {
      throw new Error("SESSION_SECRET must be at least 32 characters (see .env.example)");
    }
    return {
      port: Number(env("PORT", "8790")),
      publicBaseUrl: env("PUBLIC_BASE_URL", "http://localhost:8790").replace(/\/$/, ""),
      dataDir: path.resolve(env("DATA_DIR", "./data")),
      sessionSecret: secret,
      allowedEmailDomains: env("ALLOWED_EMAIL_DOMAINS")
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean),
      brand: {
        name: env("BRAND_NAME", "Trigenys Sign"),
        navy: env("BRAND_NAVY", "#1A0A0E"),
        orange: env("BRAND_ORANGE", "#872341"),
        offwhite: env("BRAND_OFFWHITE", "#F5F3F4"),
      },
      notify: {
        baseUrl: env("NOTIFY_BASE_URL").replace(/\/$/, ""),
        project: env("NOTIFY_PROJECT", "trigenys-sign"),
        emailKey: env("NOTIFY_EMAIL_INGEST_KEY"),
        whatsappDirectKey: env("NOTIFY_WHATSAPP_DIRECT_INGEST_KEY"),
      },
      devShowLinks: env("DEV_SHOW_LINKS") === "1",
      handoffTtlMinutes: Math.min(60, Math.max(2, Number(env("HANDOFF_TTL_MINUTES", "10")) || 10)),
      anchors: {
        enabled: env("ANCHORS_ENABLED", "1") !== "0",
        calendars: list(env("OTS_CALENDARS", "https://alice.btc.calendar.opentimestamps.org,https://bob.btc.calendar.opentimestamps.org,https://finney.calendar.eternitywall.com")),
        tsaUrls: list(env("TSA_URLS", "http://timestamp.digicert.com,https://freetsa.org/tsr")),
        explorerUrl: env("BTC_EXPLORER_URL", "https://blockstream.info/api").replace(/\/$/, ""),
        sweepMinutes: Math.max(5, Number(env("ANCHORS_SWEEP_MINUTES", "30")) || 30),
      },
    };
  } finally {
    process.env = prev;
  }
}
