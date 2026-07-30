// Guard tests for the double-count protection and st_aid stitching.
//
// The first two tests are the load-bearing ones: if `provider` or the order_id
// string form ever drifts from what api/routes/shopify-webhook.js sends in the
// main repo, this app and the manual webhook stop sharing an idempotency
// namespace and the same order gets counted twice. Run with `npm test`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDER,
  buildConversionPayload,
  extractStitchingId,
  reportConversion,
  sourcetrackApiBase,
} from "./sourcetrack.server.js";

// Swap global.fetch for one canned response. Returns a restore function.
// No network and no localhost server — this asserts the status mapping only.
function stubFetch(impl) {
  const original = global.fetch;
  global.fetch = impl;
  return () => {
    global.fetch = original;
  };
}

function jsonResponse(status, body) {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

// A minimal paid-order payload in the shape orders/paid delivers.
function order(overrides = {}) {
  return {
    id: 5500000123,
    admin_graphql_api_id: "gid://shopify/Order/5500000123",
    name: "#1001",
    order_number: 1001,
    total_price: "149.95",
    currency: "USD",
    financial_status: "paid",
    processed_at: "2026-07-30T10:00:00-04:00",
    note_attributes: [],
    ...overrides,
  };
}

test("provider is exactly 'shopify' — shares the manual rail's claim namespace", () => {
  assert.equal(PROVIDER, "shopify");
  assert.equal(buildConversionPayload(order(), "sk_test", "wh_1").body.provider, "shopify");
});

test("order_id is the numeric id as a string, NOT the graphql gid", () => {
  const { body } = buildConversionPayload(order(), "sk_test", "wh_1");
  // String(payload.id) is what shopify-webhook.js claims. A gid would not
  // collide with it, so the duplicate would slip through and double-count.
  assert.equal(body.order_id, "5500000123");
  assert.equal(typeof body.order_id, "string");
  assert.doesNotMatch(body.order_id, /gid:/);
});

test("st_aid is read from note_attributes and becomes anonymous_id", () => {
  const payload = order({
    note_attributes: [{ name: "st_aid", value: "3f1b8c2e-aaaa-4bbb-8ccc-1234567890ab" }],
  });
  const { body, stitchingMethod } = buildConversionPayload(payload, "sk_test", "wh_1");
  assert.equal(body.anonymous_id, "3f1b8c2e-aaaa-4bbb-8ccc-1234567890ab");
  assert.equal(stitchingMethod, "note_attributes.st_aid");
});

test("_st_aid wins over st_aid, matching the manual rail's key precedence", () => {
  const { stitchingId, stitchingMethod } = extractStitchingId({
    note_attributes: [
      { name: "st_aid", value: "second" },
      { name: "_st_aid", value: "first" },
    ],
  });
  assert.equal(stitchingId, "first");
  assert.equal(stitchingMethod, "note_attributes._st_aid");
});

test("the attributes object is scanned when note_attributes has no match", () => {
  const { stitchingId, stitchingMethod } = extractStitchingId({
    note_attributes: [{ name: "gift_note", value: "happy birthday" }],
    attributes: { st_aid: "from-attributes" },
  });
  assert.equal(stitchingId, "from-attributes");
  assert.equal(stitchingMethod, "attributes.st_aid");
});

test("blank and whitespace-only attribute values do not count as a match", () => {
  const { stitchingId, stitchingMethod } = extractStitchingId({
    note_attributes: [{ name: "st_aid", value: "   " }],
  });
  assert.equal(stitchingId, null);
  assert.equal(stitchingMethod, "none");
});

test("an unstitched order still reports revenue, with no anonymous_id", () => {
  const { ok, body, stitchingMethod } = buildConversionPayload(order(), "sk_test", "wh_1");
  assert.equal(ok, true);
  // The API stamps shopify_unattributed:<orderId> — revenue is recorded, and
  // honestly marked unattributed, rather than guessed at or dropped.
  assert.equal(body.anonymous_id, undefined);
  assert.equal(body.conversion_value, 149.95);
  assert.equal(stitchingMethod, "none");
});

test("webhookId is sent as provider_event_id so redeliveries dedupe", () => {
  const { body } = buildConversionPayload(order(), "sk_test", "wh_abc");
  assert.equal(body.provider_event_id, "wh_abc");
  // order_id is still sent alongside it — the claim is all-or-nothing, so the
  // shared order_id is what blocks the manual rail's duplicate.
  assert.equal(body.order_id, "5500000123");
});

test("current_total_price is the fallback when total_price is absent", () => {
  const payload = order({ total_price: undefined, current_total_price: "99.00" });
  assert.equal(buildConversionPayload(payload, "sk_test", null).body.conversion_value, 99);
});

test("a paid order with no usable currency is refused, not sent as-is", () => {
  const payload = order({ currency: "", presentment_currency: "" });
  const result = buildConversionPayload(payload, "sk_test", null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /currency/);
});

test("a zero-value order is allowed without a currency", () => {
  const payload = order({ total_price: "0.00", currency: "" });
  const result = buildConversionPayload(payload, "sk_test", null);
  assert.equal(result.ok, true);
  assert.equal(result.body.conversion_value, 0);
  assert.equal(result.body.currency, null);
});

test("a missing order id is refused rather than reported under a bad key", () => {
  const result = buildConversionPayload(order({ id: undefined }), "sk_test", null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /order id/);
});

test("a negative total is refused", () => {
  const result = buildConversionPayload(order({ total_price: "-5.00" }), "sk_test", null);
  assert.equal(result.ok, false);
  assert.match(result.reason, /value/);
});

test("occurred_at prefers processed_at, and the API base strips trailing slashes", () => {
  assert.equal(
    buildConversionPayload(order(), "sk_test", null).body.occurred_at,
    "2026-07-30T10:00:00-04:00",
  );

  const previous = process.env.SOURCETRACK_API_URL;
  process.env.SOURCETRACK_API_URL = "https://staging.example.com/";
  assert.equal(sourcetrackApiBase(), "https://staging.example.com");
  delete process.env.SOURCETRACK_API_URL;
  assert.equal(sourcetrackApiBase(), "https://api.srctk.com");
  if (previous !== undefined) process.env.SOURCETRACK_API_URL = previous;
});

// ── reportConversion: which outcomes make Shopify retry ──────────────────────
// Only 'transient' may cause a 500/retry. Mapping a rejection as transient would
// hammer Shopify's retry window for 4h; mapping a transient failure as final
// would silently lose the order.

test("a 200 success maps to 'ok'", async () => {
  const restore = stubFetch(jsonResponse(200, { success: true, duplicate: false }));
  try {
    assert.equal((await reportConversion({})).status, "ok");
  } finally {
    restore();
  }
});

test("a 200 with duplicate:true maps to 'duplicate', not 'ok'", async () => {
  const restore = stubFetch(jsonResponse(200, { success: true, duplicate: true }));
  try {
    // This is the guard firing when the manual rail already reported the order.
    assert.equal((await reportConversion({})).status, "duplicate");
  } finally {
    restore();
  }
});

test("401 (bad site key) and 402 (plan gate) are 'rejected' — never retried", async () => {
  for (const status of [400, 401, 402]) {
    const restore = stubFetch(jsonResponse(status, { error: "nope" }));
    try {
      const result = await reportConversion({});
      assert.equal(result.status, "rejected", `HTTP ${status} should be rejected`);
      assert.equal(result.httpStatus, status);
    } finally {
      restore();
    }
  }
});

test("a 5xx maps to 'transient' so Shopify redelivers", async () => {
  const restore = stubFetch(jsonResponse(503, { error: "unavailable" }));
  try {
    assert.equal((await reportConversion({})).status, "transient");
  } finally {
    restore();
  }
});

test("a network throw maps to 'transient', it does not propagate", async () => {
  const restore = stubFetch(async () => {
    throw new TypeError("fetch failed");
  });
  try {
    const result = await reportConversion({});
    assert.equal(result.status, "transient");
    assert.equal(result.error, "network error");
  } finally {
    restore();
  }
});

test("a timeout maps to 'transient' and is named as a timeout", async () => {
  const restore = stubFetch(
    async (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
  );
  try {
    const result = await reportConversion({}, { timeoutMs: 20 });
    assert.equal(result.status, "transient");
    assert.equal(result.error, "timeout");
  } finally {
    restore();
  }
});

test("a non-JSON error body still classifies by status, without throwing", async () => {
  const restore = stubFetch(async () => new Response("<html>502</html>", { status: 502 }));
  try {
    assert.equal((await reportConversion({})).status, "transient");
  } finally {
    restore();
  }
});

test("reportConversion posts to /api/conversion/offline", async () => {
  let seenUrl = null;
  const restore = stubFetch(async (url) => {
    seenUrl = url;
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  try {
    await reportConversion({ site_key: "x" });
    assert.equal(seenUrl, "https://api.srctk.com/api/conversion/offline");
  } finally {
    restore();
  }
});

test("no customer PII is ever placed in the conversion payload", () => {
  // read_customers is deliberately not requested; assert we never start relying
  // on customer fields even if Shopify includes them in the payload.
  const payload = order({
    email: "shopper@example.com",
    phone: "+15551234567",
    customer: { id: 1, email: "shopper@example.com", first_name: "Ada" },
    billing_address: { address1: "1 Main St", zip: "10001" },
  });
  const serialized = JSON.stringify(buildConversionPayload(payload, "sk_test", "wh_1").body);
  for (const leak of ["shopper@example.com", "+15551234567", "Ada", "1 Main St", "10001"]) {
    assert.equal(serialized.includes(leak), false, `payload leaked ${leak}`);
  }
});
