import assert from "node:assert/strict";
import test from "node:test";

// The module is plain browser ESM served from web/; it has no DOM dependency so Node can load it as is.
const suggest = await import(new URL("../../web/suggest.js", import.meta.url).href);

type Item = { page: number; str: string; left: number; right: number; baseline: number; lineH: number };
const it = (page: number, str: string, left: number, baseline: number, width = 0.2): Item => ({ page, str, left, right: left + width, baseline, lineH: 0.015 });

// Closing block of a three-party contract: a header, the three names, a "Signature ____" line per column.
const CONTRACT: Item[] = [
  it(1, "Contrat de prestation", 0.1, 0.1, 0.5),
  it(3, "30 % à la signature du contrat, solde à la livraison", 0.1, 0.4, 0.6),
  it(3, "Signature", 0.1, 0.42, 0.08), // stray cell label inside the payment table
  it(5, "SIGNATURES", 0.1, 0.6, 0.3),
  it(5, "LE CLIENT 1", 0.08, 0.66, 0.2),
  it(5, "LE CLIENT 2", 0.4, 0.66, 0.2),
  it(5, "LA PRESTATAIRE", 0.72, 0.66, 0.2),
  it(5, "Jennifer Lawrynn AKA'A", 0.08, 0.69, 0.25),
  it(5, "Mbowou Ibrahim Junior", 0.4, 0.69, 0.25),
  it(5, "AKA'A AMEGNEY GENEVE TIFFANY", 0.72, 0.69, 0.25),
  it(5, "Signature ______________", 0.08, 0.76, 0.25),
  it(5, "Signature ______________", 0.4, 0.76, 0.25),
  it(5, "Signature ______________", 0.72, 0.76, 0.25),
];

test("suggest: labels are recognized with trailing rules, colons or party mentions, not body text", () => {
  for (const s of ["Signature", "Signature :", "Signature ______", "Signature du client", "SIGNATURES", "Signature de la prestataire…"]) assert.ok(suggest.isAnchor(s), s);
  for (const s of ["30 % à la signature du contrat", "Signature électronique avancée", "Date et lieu"]) assert.ok(!suggest.isAnchor(s), s);
});

test("suggest: names are normalized (case, accents, apostrophes, word order)", () => {
  assert.deepEqual(suggest.nameTokens("AKA'A AMEGNEY GENEVE TIFFANY"), ["aka", "amegney", "geneve", "tiffany"]);
  assert.deepEqual(suggest.nameTokens("Mme Geneviève Aka’a"), ["genevieve", "aka"]);
});

test("suggest: each signer lands under its own name in the closing block, whatever the order given", () => {
  const signers = [
    { key: "1", name: "Tiffany Aka'a" },
    { key: "2", name: "Ibrahim Mbowou" },
    { key: "3", name: "Jennifer Aka'a" },
  ];
  const { assignment, anchors } = suggest.assignAnchors(CONTRACT, signers);
  assert.equal(anchors.length, 5, "the SIGNATURES heading, the table cell and the three columns");
  assert.deepEqual([assignment.get("1").page, assignment.get("1").left], [5, 0.72]);
  assert.deepEqual([assignment.get("2").page, assignment.get("2").left], [5, 0.4]);
  assert.deepEqual([assignment.get("3").page, assignment.get("3").left], [5, 0.08]);
  assert.ok(assignment.get("1").columns, "column layout detected");
  assert.ok(assignment.get("1").colRight <= 1 && assignment.get("2").colRight <= 0.72);
});

test("suggest: unnamed signers take the last labels of the document, left to right, never the body mention", () => {
  const signers = [{ key: "a", name: "Alice Test" }, { key: "b", name: "Bob Test" }, { key: "c", name: "Carol Test" }];
  const { assignment } = suggest.assignAnchors(CONTRACT, signers);
  assert.deepEqual(signers.map((s) => assignment.get(s.key).left), [0.08, 0.4, 0.72]);
  assert.ok(signers.every((s) => assignment.get(s.key).page === 5));
});

test("suggest: a mixed case keeps the named match and gives the rest the remaining last labels", () => {
  const signers = [{ key: "x", name: "Someone Else" }, { key: "j", name: "jennifer aka'a" }];
  const { assignment } = suggest.assignAnchors(CONTRACT, signers);
  assert.equal(assignment.get("j").left, 0.08);
  assert.equal(assignment.get("x").left, 0.4, "first free label of the closing line");
});

test("suggest: labels already covered by a placed box are skipped", () => {
  const signers = [{ key: "n", name: "New Signer" }];
  const taken = [{ page: 5, left: 0.08, right: 0.28, baseline: 0.764 }, { page: 5, left: 0.4, right: 0.6, baseline: 0.764 }];
  const { assignment } = suggest.assignAnchors(CONTRACT, signers, taken);
  assert.equal(assignment.get("n").left, 0.72);
});

test("suggest: a single label on its line is not treated as a column", () => {
  const items = [it(1, "Fait à Douala", 0.1, 0.8, 0.3), it(1, "Signature :", 0.1, 0.85, 0.1)];
  const { assignment } = suggest.assignAnchors(items, [{ key: "a", name: "Alice" }]);
  assert.equal(assignment.get("a").columns, false);
  assert.equal(assignment.get("a").colRight, 1);
});
