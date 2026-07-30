import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Drop the shop's SourceTrack site key too. It is the merchant's credential;
  // holding it after they have uninstalled us serves no purpose. deleteMany (not
  // delete) so a redelivery after the row is gone is a no-op rather than a throw.
  await db.sourcetrackConfig.deleteMany({ where: { shop } });

  return new Response();
};
