// SourceTrack conversion reporting for paid Shopify orders.
//
// ───────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE LOOKS THE WAY IT DOES: THE DOUBLE-COUNT GUARD
// ───────────────────────────────────────────────────────────────────────────────
// SourceTrack already has a Shopify rail that predates this app: the merchant
// hand-creates an orders/paid webhook in the Shopify admin pointing at
// POST /api/webhooks/shopify/:site_key (api/routes/shopify-webhook.js in the
// main repo). A merchant who installs this app WITHOUT deleting that webhook has
// two producers reporting the same order.
//
// De-duplication in SourceTrack is namespaced by PROVIDER, not by order id
// alone. The claim table's unique constraint is
//     (site_key, provider, key_type, key_value)
// so `order_id = 5500000123` claimed under provider 'shopify' and under any
// other provider string are two different rows — both claims succeed, and
// nothing downstream merges them:
//   - the Tinybird `events` datasource is an append-only MergeTree (NOT
//     ReplacingMergeTree) — it dedupes nothing by design, and the live revenue
//     pipes sum straight off it, one of them explicitly assuming "1 row per
//     $conversion (event_id unique)".
//   - only the nightly job's upsert onto attributed_conversions would collapse
//     them, ~24h later, and only in Postgres. Dashboards would read double
//     revenue until then.
//
// So this app reports under the EXACT SAME provider + order_id form as the
// manual rail:
//     provider = 'shopify'   (byte-identical to shopify-webhook.js)
//     order_id = String(payload.id)   (the numeric REST order id, as a string)
// which puts both producers in ONE claim namespace. Whichever webhook lands
// second gets `{ duplicate: true }` and never writes an event. Same rail, not a
// second one.
//
// Every other field is mirrored from the manual rail for the same reason: if the
// guard ever fails, the two rows should be identical (which the nightly
// collapses) rather than contradictory (which it cannot).
//
// DO NOT change `PROVIDER`, or the order_id string form, without re-reading the
// above. They are the guard.
// ───────────────────────────────────────────────────────────────────────────────

// Must stay byte-identical to shopify-webhook.js's provider string — this is
// what shares the idempotency namespace with the manual rail.
export const PROVIDER = "shopify";

// The main SourceTrack API. Overridable for staging; defaults to production.
export function sourcetrackApiBase() {
  const raw = process.env.SOURCETRACK_API_URL;
  const base = raw && raw.trim() ? raw.trim() : "https://api.srctk.com";
  return base.replace(/\/+$/, "");
}

// Cart-attribute keys that may carry the anonymous visitor id, in the same
// precedence order the manual rail scans (shopify-webhook.js). The documented
// storefront snippet writes `st_aid`; the rest are accepted aliases.
const STITCHING_KEYS = [
  "_st_aid",
  "st_aid",
  "anonymous_id",
  "visitor_id",
  "sourcetrack_user_id",
  "site_user_id",
];

/**
 * Pull the SourceTrack visitor id out of a paid-order payload.
 *
 * Shopify carries cart attributes through checkout onto the order as
 * `note_attributes: [{ name, value }]`. Newer payload shapes may instead expose
 * an `attributes` object, so both are scanned — note_attributes first, matching
 * the manual rail's precedence exactly.
 *
 * @returns {{ stitchingId: string|null, stitchingMethod: string }}
 */
export function extractStitchingId(payload) {
  const noteAttributes = payload?.note_attributes;
  if (Array.isArray(noteAttributes)) {
    for (const key of STITCHING_KEYS) {
      const attr = noteAttributes.find((a) => a && a.name === key);
      const value = attr && attr.value != null ? String(attr.value).trim() : "";
      if (value) {
        return { stitchingId: value, stitchingMethod: `note_attributes.${key}` };
      }
    }
  }

  const attributes = payload?.attributes;
  if (attributes && typeof attributes === "object" && !Array.isArray(attributes)) {
    for (const key of STITCHING_KEYS) {
      const value =
        attributes[key] != null ? String(attributes[key]).trim() : "";
      if (value) {
        return { stitchingId: value, stitchingMethod: `attributes.${key}` };
      }
    }
  }

  return { stitchingId: null, stitchingMethod: "none" };
}

/**
 * Turn a paid-order webhook payload into the /api/conversion/offline body.
 *
 * Returns { ok: false, reason } rather than throwing, so the caller decides the
 * HTTP status — a malformed payload must not be retried forever, but it must
 * also never be acked as a silent success.
 *
 * @param {object} payload  the orders/paid webhook body
 * @param {string} siteKey  the shop's configured SourceTrack site key
 * @param {string|null} webhookId  X-Shopify-Webhook-Id (dedupes redeliveries)
 */
export function buildConversionPayload(payload, siteKey, webhookId) {
  // order_id: the numeric REST order id as a string. This exact form is the
  // shared idempotency key with the manual rail — NOT admin_graphql_api_id
  // ("gid://shopify/Order/123"), which would not collide and would double-count.
  const orderId = payload?.id != null ? String(payload.id).trim() : "";
  if (!orderId) {
    return { ok: false, reason: "missing order id" };
  }

  // Mirror the manual rail: prefer total_price, fall back to
  // current_total_price. current_total_price reflects post-edit totals, so it is
  // the fallback, not the primary.
  const rawValue =
    payload?.total_price !== undefined
      ? payload.total_price
      : payload?.current_total_price;
  const value = parseFloat(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, reason: "invalid order value" };
  }

  const currency = String(payload?.currency || payload?.presentment_currency || "")
    .trim()
    .toUpperCase();
  // The API requires a currency whenever value > 0 and rejects the request
  // otherwise; catch it here so the failure is named rather than a bare 400.
  if (value > 0 && !/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, reason: "invalid or missing currency" };
  }

  const { stitchingId, stitchingMethod } = extractStitchingId(payload);

  const body = {
    site_key: siteKey,
    provider: PROVIDER,
    order_id: orderId,
    conversion_value: value,
    currency: currency || null,
    conversion_type: "purchase",
    occurred_at: payload?.processed_at || payload?.created_at || undefined,
    // Mirrors shopify-webhook.js. Not an attribution claim about the shopper —
    // it names the rail the conversion arrived on. The nightly job re-derives
    // real attribution from the stitched visitor's own touchpoints.
    utm_source: "shopify",
    utm_medium: "webhook",
    first_touch_source: "shopify",
    first_touch_medium: "webhook",
    properties: {
      order_name:
        payload?.name ||
        (payload?.order_number != null ? String(payload.order_number) : null) ||
        null,
      ingestion_method: "webhook_shopify_app",
      stitching_method: stitchingMethod,
    },
  };

  // Dedupes Shopify's own redeliveries of one event (the id is stable across
  // the 8-attempt retry window). Deliberately sent alongside order_id: the
  // claim is all-or-nothing, so the shared order_id still rolls the whole claim
  // back when the manual rail already reported this order.
  if (webhookId) {
    body.provider_event_id = String(webhookId);
  }

  // No anonymous_id => the API stamps distinct_id
  // `shopify_unattributed:<orderId>` and attribution_status 'unattributed' —
  // the same phantom id the manual rail produces for an unstitched order. The
  // revenue is recorded honestly as unattributed rather than guessed at.
  if (stitchingId) {
    body.anonymous_id = stitchingId;
  }

  return { ok: true, body, orderId, value, currency, stitchingMethod };
}

/**
 * POST a built conversion to SourceTrack.
 *
 * @returns {Promise<{ status: 'ok'|'duplicate'|'rejected'|'transient',
 *                     httpStatus?: number, error?: string }>}
 *
 * 'transient' is the only status the caller should retry on. 'rejected' means
 * SourceTrack refused the payload (4xx) — retrying cannot fix it.
 */
export async function reportConversion(body, { timeoutMs = 10000 } = {}) {
  const url = `${sourcetrackApiBase()}/api/conversion/offline`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // Network failure or timeout — genuinely retryable.
    return { status: "transient", error: err?.name === "AbortError" ? "timeout" : "network error" };
  } finally {
    clearTimeout(timer);
  }

  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    /* a non-JSON body is diagnosed by status alone */
  }

  if (response.ok) {
    return {
      status: parsed?.duplicate ? "duplicate" : "ok",
      httpStatus: response.status,
    };
  }

  // 402 = plan/trial gate, 401 = bad site key: both are merchant-config
  // problems that retrying will not clear.
  if (response.status >= 400 && response.status < 500) {
    return {
      status: "rejected",
      httpStatus: response.status,
      // Never echo the request body back — it carries the site key.
      error: typeof parsed?.error === "string" ? parsed.error : "rejected",
    };
  }

  return { status: "transient", httpStatus: response.status, error: "upstream 5xx" };
}
