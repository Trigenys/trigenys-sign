import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface User {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  created_at: string;
}

export interface SigningKey {
  id: string;
  user_id: string;
  public_key_jwk: string;
  fingerprint: string;
  signature_png: string; // data URL
  strokes_json: string;
  created_at: string;
  superseded_at: string | null;
}

export interface Document {
  id: string;
  owner_id: string;
  title: string;
  file_path: string;
  sha256: string;
  size: number;
  status: "draft" | "pending" | "completed";
  created_at: string;
  completed_at: string | null;
}

export interface Signer {
  id: string;
  document_id: string;
  user_id: string;
  token_hash: string;
  position: number;
  signed_at: string | null;
  key_id: string | null;
  payload_json: string | null;
  signature_b64: string | null;
  notified_at: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  phone TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS signing_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key_jwk TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  signature_png TEXT NOT NULL,
  strokes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  superseded_at TEXT
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  file_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS signers (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  signed_at TEXT,
  key_id TEXT REFERENCES signing_keys(id),
  payload_json TEXT,
  signature_b64 TEXT,
  notified_at TEXT,
  UNIQUE(document_id, user_id)
);
CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  recipient_hint TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
`;

export class Db {
  readonly sql: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(path.join(dataDir, "files"), { recursive: true });
    this.sql = new DatabaseSync(path.join(dataDir, "trigenys-sign.sqlite"));
    this.sql.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.sql.exec(SCHEMA);
  }

  get<T>(query: string, ...params: unknown[]): T | undefined {
    return this.sql.prepare(query).get(...(params as never[])) as T | undefined;
  }
  all<T>(query: string, ...params: unknown[]): T[] {
    return this.sql.prepare(query).all(...(params as never[])) as T[];
  }
  run(query: string, ...params: unknown[]): void {
    this.sql.prepare(query).run(...(params as never[]));
  }
  transaction<T>(fn: () => T): T {
    this.sql.exec("BEGIN");
    try {
      const r = fn();
      this.sql.exec("COMMIT");
      return r;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }
}

export const now = (): string => new Date().toISOString();
