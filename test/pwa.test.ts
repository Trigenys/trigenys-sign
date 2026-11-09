import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, webManifest } from "../src/server.js";
import { testEnv } from "./helpers.js";

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const { cfg, svc } = testEnv({ BRAND_NAME: "Acme Sign" });
  const server = createServer(cfg, svc);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  try {
    return await fn(base);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("manifest follows the brand config and points at served icons", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/manifest.webmanifest`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/manifest\+json/);
    const m = (await res.json()) as ReturnType<typeof webManifest>;
    assert.equal(m.name, "Acme Sign");
    assert.equal(m.display, "standalone");
    assert.equal(m.theme_color, "#F5F3F4");
    assert.ok(m.icons.some((i) => i.purpose === "maskable"));
    for (const icon of m.icons) {
      const r = await fetch(base + icon.src);
      assert.equal(r.status, 200, icon.src);
      assert.equal(r.headers.get("content-type"), "image/png");
    }
  });
});

test("service worker is served from the root with a script content type", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/sw.js`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /javascript/);
    const body = await res.text();
    assert.match(body, /startsWith\("\/static\/"\)/, "only static assets are cached");
    assert.doesNotMatch(body, /\/api\//);
    const pages = await Promise.all(["/", "/verify/x", "/s/x", "/h/x"].map((p) => fetch(base + p).then((r) => r.text())));
    for (const html of pages) {
      assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
      assert.match(html, /name="theme-color"/);
    }
  });
});

test("short_name stays within twelve characters for long brand names", () => {
  const { cfg } = testEnv({ BRAND_NAME: "Entreprise Generale Sign" });
  assert.equal(webManifest(cfg).short_name, "Sign");
});
