// Copies the self-hosted browser libraries from node_modules into web/vendor/ (gitignored).
// pdf.js: the legacy build ships the polyfills (Uint8Array.toHex, …) that the modern build expects
// from very recent engines; without them the preview fails on browsers only a few months old.
// Idempotent: a file is rewritten only when its content differs.
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const pdfjsDir = dirname(require.resolve("pdfjs-dist/package.json"));

const FILES = [
  [join(pdfjsDir, "legacy", "build", "pdf.min.mjs"), join(root, "web", "vendor", "pdfjs", "pdf.min.mjs")],
  [join(pdfjsDir, "legacy", "build", "pdf.worker.min.mjs"), join(root, "web", "vendor", "pdfjs", "pdf.worker.min.mjs")],
];

let written = 0;
for (const [from, to] of FILES) {
  if (!existsSync(from)) throw new Error(`Missing vendor source: ${from}`);
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to) && readFileSync(from).equals(readFileSync(to))) continue;
  copyFileSync(from, to);
  written++;
}
console.log(`vendor: ${written} file(s) updated, ${FILES.length - written} unchanged`);
