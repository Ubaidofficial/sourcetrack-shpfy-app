import { useEffect, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  maskSiteKey,
  readSiteKey,
  saveSiteKey,
} from "../sourcetrack-config.server";

// Accepts both site-key shapes in the wild: the uuid the sites table defaults to
// and prefixed keys. Deliberately loose on shape, strict on charset — the API is
// the authority on whether a key is real.
const SITE_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const config = await db.sourcetrackConfig.findUnique({
    where: { shop: session.shop },
  });

  // Decrypt, then mask. The mask is a suffix of the real key, so it is only
  // ever derived from a value that decrypted cleanly — a stored value we cannot
  // read is reported as broken, not rendered as a reassuring row of dots.
  const stored = config ? readSiteKey(config) : null;
  if (stored && !stored.ok) {
    console.error(
      `[settings] ${session.shop}: stored site key could not be decrypted (${stored.reason}). ` +
        `Orders are NOT being reported until the merchant re-enters it.`,
    );
  }

  return {
    shop: session.shop,
    // Only ever the mask crosses to the browser.
    maskedSiteKey: stored?.ok ? maskSiteKey(stored.siteKey) : null,
    siteKeyUnreadable: Boolean(stored && !stored.ok),
    configuredAt: config?.updatedAt ? config.updatedAt.toISOString() : null,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "save");

  if (intent === "disconnect") {
    await db.sourcetrackConfig.deleteMany({ where: { shop: session.shop } });
    return { ok: true, disconnected: true };
  }

  const siteKey = String(formData.get("siteKey") || "").trim();

  if (!siteKey) {
    return { ok: false, error: "Enter your SourceTrack site key." };
  }
  if (!SITE_KEY_PATTERN.test(siteKey)) {
    // Never echo the rejected value back — it may be a real key.
    return {
      ok: false,
      error:
        "That does not look like a site key. Copy it from SourceTrack → Settings → Install.",
    };
  }

  try {
    await saveSiteKey(db, session.shop, siteKey);
  } catch (err) {
    // Encryption failed — almost certainly a missing or malformed
    // SOURCETRACK_CONFIG_ENCRYPTION_KEY on this deployment. Fail the save.
    // Storing the key unencrypted instead is never the fallback. err.message
    // names the env var, never a value.
    console.error(
      `[settings] ${session.shop}: site key NOT saved — ${err.message}`,
    );
    return {
      ok: false,
      error:
        "Could not securely store the site key. This is a problem on our side — please contact SourceTrack support.",
    };
  }

  return { ok: true, saved: true };
};

export default function Index() {
  const { shop, maskedSiteKey, siteKeyUnreadable, configuredAt } =
    useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [siteKey, setSiteKey] = useState("");

  const isSubmitting =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (fetcher.data?.saved) {
      shopify.toast.show("SourceTrack connected");
      setSiteKey("");
    }
    if (fetcher.data?.disconnected) {
      shopify.toast.show("SourceTrack disconnected");
    }
  }, [fetcher.data, shopify]);

  const save = () =>
    fetcher.submit({ intent: "save", siteKey }, { method: "POST" });
  const disconnect = () =>
    fetcher.submit({ intent: "disconnect" }, { method: "POST" });

  const isConnected = Boolean(maskedSiteKey);
  const error = fetcher.data?.ok === false ? fetcher.data.error : null;

  return (
    <s-page heading="SourceTrack">
      <s-section heading="Connect this store to SourceTrack">
        <s-paragraph>
          Paid orders from <s-text>{shop}</s-text> are reported to SourceTrack as
          conversions, so revenue is attributed to the marketing source that
          earned it. Enter the site key for the SourceTrack workspace this store
          should report to.
        </s-paragraph>

        {isConnected && (
          <s-banner tone="success" heading="Connected">
            <s-paragraph>
              Reporting to site key <s-text>{maskedSiteKey}</s-text>
              {configuredAt ? ` — saved ${configuredAt.slice(0, 10)}` : ""}. Enter
              a new key below to change it.
            </s-paragraph>
          </s-banner>
        )}

        {siteKeyUnreadable && (
          <s-banner tone="critical" heading="Site key needs re-entering">
            <s-paragraph>
              A site key is stored for this store but cannot be read back, so
              orders are not being reported. Enter the key again below to fix
              it.
            </s-paragraph>
          </s-banner>
        )}

        {error && (
          <s-banner tone="critical" heading="Could not save">
            <s-paragraph>{error}</s-paragraph>
          </s-banner>
        )}

        <s-text-field
          label="SourceTrack site key"
          name="siteKey"
          value={siteKey}
          placeholder={
            isConnected ? "Enter a new key to replace the current one" : ""
          }
          details="Found in SourceTrack under Settings → Install."
          onChange={(event) => setSiteKey(event.target.value)}
        />

        <s-stack direction="inline" gap="base">
          <s-button
            onClick={save}
            variant="primary"
            {...(isSubmitting ? { loading: true } : {})}
            {...(siteKey.trim() ? {} : { disabled: true })}
          >
            {isConnected ? "Update site key" : "Connect"}
          </s-button>
          {isConnected && (
            <s-button onClick={disconnect} variant="tertiary" tone="critical">
              Disconnect
            </s-button>
          )}
        </s-stack>
      </s-section>

      <s-section heading="Before you rely on the numbers">
        <s-paragraph>
          Two setup steps live in your theme, not in this app, and attribution is
          incomplete without them:
        </s-paragraph>
        <s-ordered-list>
          <s-list-item>
            The SourceTrack tracking script must be installed on your storefront.
          </s-list-item>
          <s-list-item>
            The cart must carry the visitor id as an <code>st_aid</code> cart
            attribute. Without it, orders still record their revenue but are
            marked unattributed — no source, no campaign.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section slot="aside" heading="Already using the manual webhook?">
        <s-paragraph>
          If you previously created an orders webhook in Shopify pointing at
          SourceTrack, you can leave it in place — an order reported twice is
          recorded once, because both routes share the same order id. Removing it
          is still cleaner, and refunds are currently handled only by that manual
          webhook.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
