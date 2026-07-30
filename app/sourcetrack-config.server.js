// Explicit .js extension: this module is loaded directly by `node --test`, which
// (unlike Vite) does not resolve extensionless specifiers.
import { encryptSecret, decryptSecret } from "./crypto.server.js";

// The one place that knows a site key is stored as ciphertext.
//
// The column is `siteKeyEncrypted`, not `siteKey`, precisely so that no future
// call site can hand the stored value straight to buildConversionPayload and
// ship AES output to /api/conversion/offline. Everything that needs the real
// key goes through readSiteKey() below.
//
// The Prisma client is passed in rather than imported so these functions are
// testable without a database — the tests assert the exact value handed to
// Prisma for the column, which is the value that lands on disk.

/**
 * Encrypt and persist a shop's site key.
 *
 * Throws if encryption fails (missing/malformed key env var). The caller must
 * surface that as a failed save — storing plaintext instead is never the
 * fallback.
 *
 * @param {object} db     Prisma client
 * @param {string} shop   myshopify domain
 * @param {string} siteKey  plaintext site key as the merchant pasted it
 */
export async function saveSiteKey(db, shop, siteKey) {
  const siteKeyEncrypted = encryptSecret(siteKey);
  await db.sourcetrackConfig.upsert({
    where: { shop },
    create: { shop, siteKeyEncrypted },
    update: { siteKeyEncrypted },
  });
}

/**
 * Decrypt a stored config row.
 *
 * Returns a result object rather than throwing, matching buildConversionPayload
 * — the money path decides its own HTTP status, and a crypto stack trace must
 * never escape into a webhook handler.
 *
 * @param {{ siteKeyEncrypted?: string }|null} config
 * @returns {{ ok: true, siteKey: string } | { ok: false, reason: string }}
 */
export function readSiteKey(config) {
  if (!config?.siteKeyEncrypted) {
    return { ok: false, reason: "no site key stored" };
  }

  let siteKey;
  try {
    siteKey = decryptSecret(config.siteKeyEncrypted);
  } catch (err) {
    // Never include the stored value in the reason — on a format failure it
    // could be a legacy plaintext key, i.e. the credential itself.
    return { ok: false, reason: err.message };
  }

  if (!siteKey) {
    return { ok: false, reason: "stored site key decrypted to an empty value" };
  }

  return { ok: true, siteKey };
}

/**
 * Show enough for the merchant to confirm they pasted the right key, never the
 * key itself. Takes the DECRYPTED key — callers read then mask, so the mask is
 * a suffix of the real key rather than a slice of ciphertext.
 *
 * @param {string} siteKey  plaintext, from readSiteKey()
 */
export function maskSiteKey(siteKey) {
  return `••••••••${siteKey.slice(-4)}`;
}
