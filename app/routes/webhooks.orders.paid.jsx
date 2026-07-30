import { authenticate } from "../shopify.server";
import db from "../db.server";
import { buildConversionPayload, reportConversion } from "../sourcetrack.server";
import { readSiteKey } from "../sourcetrack-config.server";

// orders/paid -> SourceTrack $conversion.
//
// authenticate.webhook() verifies the X-Shopify-Hmac-Sha256 signature against
// this app's own SHOPIFY_API_SECRET and throws a 401 Response on failure, so
// everything below runs on a verified payload. This is a DIFFERENT secret from
// the merchant's admin-created webhook secret used by the manual rail — the two
// rails authenticate independently.
//
// See app/sourcetrack.server.js for the double-count guard against the manual
// rail. This handler's job is to extract, report, and pick an HTTP status that
// tells the truth about what happened.
export const action = async ({ request }) => {
  const { shop, topic, payload, webhookId } =
    await authenticate.webhook(request);

  if (topic !== "ORDERS_PAID") {
    console.log(`[orders/paid] ignoring unexpected topic ${topic} for ${shop}`);
    return new Response();
  }

  const config = await db.sourcetrackConfig.findUnique({ where: { shop } });
  if (!config?.siteKeyEncrypted) {
    // Not a transient failure: no amount of retrying makes an unconfigured shop
    // configured. Ack so Shopify does not burn its retry window, but log loudly
    // — silent 200s on the money rail are how revenue goes missing unnoticed.
    console.error(
      `[orders/paid] ${shop}: NOT REPORTED — no SourceTrack site key configured. ` +
        `Order ${payload?.id ?? "unknown"} was NOT sent. Merchant must complete setup in the app.`,
    );
    return new Response();
  }

  // The stored column is ciphertext. This is the ONLY place the real key is
  // recovered, and it exists solely to be POSTed to SourceTrack below.
  const stored = readSiteKey(config);
  if (!stored.ok) {
    // Usually a missing SOURCETRACK_CONFIG_ENCRYPTION_KEY on this deployment,
    // which a redeploy fixes — so 500 and let Shopify redeliver into the fixed
    // deployment rather than acking the order into oblivion. If instead the
    // stored value is genuinely unrecoverable, the retries fail too and the
    // merchant re-enters the key in the app; either way the failure is loud.
    console.error(
      `[orders/paid] ${shop}: NOT REPORTED — stored site key could not be decrypted ` +
        `(${stored.reason}) for order ${payload?.id ?? "unknown"}. Returning 500 for Shopify retry.`,
    );
    return new Response("SourceTrack site key unreadable", { status: 500 });
  }

  const built = buildConversionPayload(payload, stored.siteKey, webhookId);
  if (!built.ok) {
    // A verified Shopify payload we cannot parse is a real defect (payload-shape
    // drift, or an order with no usable total). Retrying an unparseable payload
    // just repeats the failure, so ack — but at error level, with the order id,
    // so it surfaces instead of vanishing.
    console.error(
      `[orders/paid] ${shop}: NOT REPORTED — ${built.reason} for order ${payload?.id ?? "unknown"}. ` +
        `Possible payload-shape drift; investigate before assuming revenue is complete.`,
    );
    return new Response();
  }

  const result = await reportConversion(built.body);

  // Never log the site key or the request body — only non-secret identifiers.
  const tag = `[orders/paid] ${shop} order ${built.orderId} (${built.stitchingMethod})`;

  if (result.status === "ok") {
    console.log(`${tag}: reported ${built.value} ${built.currency || "-"}`);
    return new Response();
  }

  if (result.status === "duplicate") {
    // Expected and correct whenever the manual rail already reported this
    // order, or Shopify redelivered. The guard working, not a problem.
    console.log(`${tag}: already recorded by SourceTrack (duplicate) — no double count`);
    return new Response();
  }

  if (result.status === "rejected") {
    console.error(
      `${tag}: REJECTED by SourceTrack (HTTP ${result.httpStatus}: ${result.error}). ` +
        `Not retryable — check the site key and plan status.`,
    );
    return new Response();
  }

  // Transient: return 500 so Shopify redelivers within its retry window rather
  // than dropping the order. The site_key + order_id idempotency claim is what
  // makes that redelivery safe.
  console.error(
    `${tag}: transient failure (${result.error}) — returning 500 for Shopify retry`,
  );
  return new Response("Temporary failure reporting conversion", { status: 500 });
};
