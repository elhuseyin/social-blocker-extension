/**
 * Stripe webhook event handling — keep premium flags in sync with payments.
 */

import * as db from "./db.js";

function sessionUserId(session) {
  return session.client_reference_id || session.metadata?.extension_user_id || null;
}

export async function handleStripeEvent(stripe, event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const userId = sessionUserId(session);
      if (!userId) {
        console.warn("[billing] checkout.session.completed missing client_reference_id");
        break;
      }

      const paidLike =
        session.payment_status === "paid" ||
        session.payment_status === "no_payment_required" ||
        session.status === "complete";
      if (!paidLike) {
        break;
      }

      const mode = session.mode;
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
      const email = session.customer_details?.email || session.customer_email || null;
      const subscriptionId =
        typeof session.subscription === "string" ? session.subscription : session.subscription?.id;

      if (mode === "subscription") {
        db.upsertUserPremium({
          id: userId,
          email,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId || null,
          premium: true,
          premiumSource: "stripe_subscription"
        });
      } else if (mode === "payment") {
        db.upsertUserPremium({
          id: userId,
          email,
          stripeCustomerId: customerId,
          stripeSubscriptionId: null,
          premium: true,
          premiumSource: "stripe_onetime"
        });
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
      if (!customerId) break;
      const user = db.findUserByCustomerId(customerId);
      if (!user) break;
      if (user.premium_source === "stripe_subscription") {
        db.upsertUserPremium({
          id: user.id,
          stripeCustomerId: customerId,
          stripeSubscriptionId: null,
          premium: false,
          premiumSource: "stripe_subscription_ended"
        });
      }
      break;
    }

    default:
      break;
  }
}

export function verifyWebhook(stripe, rawBody, sig, secret) {
  return stripe.webhooks.constructEvent(rawBody, sig, secret);
}
