// The two load-bearing claims of the at-rest encryption work:
//
//   1. after a save, the value handed to the database for that column is NOT
//      the plaintext site key, and
//   2. the decrypt-then-report chain still POSTs the REAL site key to
//      /api/conversion/offline.
//
// If (1) regresses, the protected-customer-data answer "we encrypt at rest"
// becomes false again. If (2) regresses, every merchant's orders 401 silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  saveSiteKey,
  readSiteKey,
  maskSiteKey,
} from "./sourcetrack-config.server.js";
import { decryptSecret } from "./crypto.server.js";
import { buildConversionPayload, reportConversion } from "./sourcetrack.server.js";

// The key is read lazily, per call — setting it here is in time for every test.
process.env.SOURCETRACK_CONFIG_ENCRYPTION_KEY = crypto
  .randomBytes(32)
  .toString("hex");

const SHOP = "test-store.myshopify.com";
const SITE_KEY = "st_live_9f2c4b7ae1d84c0fa3e6";

// Stands in for the Prisma client, recording the exact row Prisma is asked to
// write. That recorded object is what SQLite persists, so asserting on it is
// asserting on the column value at rest.
function fakeDb() {
  const writes = [];
  return {
    writes,
    sourcetrackConfig: {
      upsert: async (args) => {
        writes.push(args);
        return { shop: args.where.shop, ...args.create };
      },
    },
  };
}

test("the saved column value is ciphertext — the plaintext site key is never written", async () => {
  const db = fakeDb();
  await saveSiteKey(db, SHOP, SITE_KEY);

  assert.equal(db.writes.length, 1);
  const { create, update } = db.writes[0];

  // Both branches of the upsert (first connect, and re-connect with a new key).
  for (const row of [create, update]) {
    assert.notEqual(row.siteKeyEncrypted, SITE_KEY);
    assert.equal(row.siteKeyEncrypted.includes(SITE_KEY), false);
    // The old plaintext column must not be written alongside it.
    assert.equal("siteKey" in row, false);
    assert.match(row.siteKeyEncrypted, /^[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$/);
  }

  // Nothing anywhere in the recorded write carries the key in the clear.
  assert.equal(JSON.stringify(db.writes).includes(SITE_KEY), false);

  // And it is real encryption, not a hash or a truncation: it decrypts back.
  assert.equal(decryptSecret(create.siteKeyEncrypted), SITE_KEY);
});

test("re-saving produces a different ciphertext for the same key", async () => {
  const db = fakeDb();
  await saveSiteKey(db, SHOP, SITE_KEY);
  await saveSiteKey(db, SHOP, SITE_KEY);
  assert.notEqual(
    db.writes[0].create.siteKeyEncrypted,
    db.writes[1].create.siteKeyEncrypted,
  );
});

test("a failed encryption fails the save — it never falls back to plaintext", async () => {
  const previous = process.env.SOURCETRACK_CONFIG_ENCRYPTION_KEY;
  delete process.env.SOURCETRACK_CONFIG_ENCRYPTION_KEY;
  const db = fakeDb();
  try {
    await assert.rejects(() => saveSiteKey(db, SHOP, SITE_KEY));
    assert.equal(db.writes.length, 0, "nothing may be written when encryption fails");
  } finally {
    process.env.SOURCETRACK_CONFIG_ENCRYPTION_KEY = previous;
  }
});

test("readSiteKey returns the real key back from a stored row", async () => {
  const db = fakeDb();
  await saveSiteKey(db, SHOP, SITE_KEY);
  const stored = readSiteKey({ siteKeyEncrypted: db.writes[0].create.siteKeyEncrypted });
  assert.equal(stored.ok, true);
  assert.equal(stored.siteKey, SITE_KEY);
});

test("a legacy plaintext row is reported unreadable, not used as a key", () => {
  // The pre-migration row shape. Trusting it would silently re-open the hole.
  const stored = readSiteKey({ siteKeyEncrypted: SITE_KEY });
  assert.equal(stored.ok, false);
  assert.match(stored.reason, /format/);
  assert.equal(stored.reason.includes(SITE_KEY), false, "the reason leaked the key");
});

test("an empty or missing row is reported unreadable rather than throwing", () => {
  assert.equal(readSiteKey(null).ok, false);
  assert.equal(readSiteKey({}).ok, false);
  assert.equal(readSiteKey({ siteKeyEncrypted: "" }).ok, false);
});

test("the mask is derived from the decrypted key, and shows only the last 4", async () => {
  const db = fakeDb();
  await saveSiteKey(db, SHOP, SITE_KEY);
  const stored = readSiteKey({ siteKeyEncrypted: db.writes[0].create.siteKeyEncrypted });
  const masked = maskSiteKey(stored.siteKey);

  assert.equal(masked, `••••••••${SITE_KEY.slice(-4)}`);
  assert.equal(masked.includes(SITE_KEY), false);
  // Not a slice of the stored ciphertext — the visible suffix is the real key's.
  assert.equal(
    db.writes[0].create.siteKeyEncrypted.endsWith(SITE_KEY.slice(-4)),
    false,
  );
});

test("decrypt-then-report sends the REAL site key to /api/conversion/offline", async () => {
  const db = fakeDb();
  await saveSiteKey(db, SHOP, SITE_KEY);

  // Exactly the chain webhooks.orders.paid.jsx runs: stored row -> decrypt ->
  // build -> POST.
  const stored = readSiteKey({ siteKeyEncrypted: db.writes[0].create.siteKeyEncrypted });
  assert.equal(stored.ok, true);

  const built = buildConversionPayload(
    { id: 5500000123, total_price: "149.95", currency: "USD" },
    stored.siteKey,
    "wh_1",
  );
  assert.equal(built.ok, true);

  let seenUrl = null;
  let seenBody = null;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    seenUrl = url;
    seenBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    const result = await reportConversion(built.body);
    assert.equal(result.status, "ok");
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(seenUrl, "https://api.srctk.com/api/conversion/offline");
  // The wire carries the plaintext key — encryption is at rest, not in the
  // payload. A ciphertext here would 401 every order.
  assert.equal(seenBody.site_key, SITE_KEY);
  assert.doesNotMatch(seenBody.site_key, /^[0-9a-f]{24}:/);
});
