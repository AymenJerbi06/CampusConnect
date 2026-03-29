/**
 * billing.js — Stripe Checkout + Billing + Customer Portal
 *
 * Flow:
 *  1. User visits /upgrade.html → clicks "Upgrade"
 *  2. POST /api/billing/checkout → returns Stripe Checkout URL
 *  3. Stripe redirects to success_url after payment
 *  4. Stripe sends checkout.session.completed webhook → backend marks premium
 *
 * Webhook events handled:
 *  - checkout.session.completed          → activate premium
 *  - customer.subscription.updated       → sync status (active=premium, else free)
 *  - customer.subscription.deleted       → downgrade to free
 *  - invoice.payment_failed              → log; optionally email user
 *
 * IMPORTANT: the webhook handler must receive the raw request body for
 * signature verification. In index.js it is mounted BEFORE express.json()
 * with express.raw({ type: 'application/json' }).
 */

const express       = require('express');
const router        = express.Router();
const requireAuth   = require('../middleware/requireAuth');
const { run, queryOne } = require('../db');

// Lazy-load stripe so the app boots fine even without STRIPE_SECRET_KEY set
// (dev environments without billing). Will throw at request time if missing.
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
  return require('stripe')(key);
}

const FRONTEND_URL = () => process.env.FRONTEND_URL || 'http://localhost:3000';

// ── POST /api/billing/checkout ────────────────────────────────────────────────
// Creates a Stripe Checkout session and returns the hosted URL.
// Accepts optional body param `plan`: 'premium' (default) | 'cross_campus'
router.post('/checkout', requireAuth, async (req, res) => {
  try {
    const stripe   = getStripe();
    const user     = req.user;
    const planType = req.body.plan === 'cross_campus' ? 'cross_campus' : 'premium';

    // Resolve the correct Stripe price ID for the chosen plan
    const priceId = planType === 'cross_campus'
      ? process.env.STRIPE_CROSS_CAMPUS_PRICE_ID
      : process.env.STRIPE_PRICE_ID;

    if (!priceId) {
      return res.status(500).json({ success: false, message: `Price ID for ${planType} plan is not configured.` });
    }

    // If the user already has a Stripe customer record, reuse it
    const customerParams = user.stripe_customer_id
      ? { customer: user.stripe_customer_id }
      : { customer_email: user.email };

    const session = await stripe.checkout.sessions.create({
      ...customerParams,
      client_reference_id: String(user.id),
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      mode:        'subscription',
      success_url: `${FRONTEND_URL()}/home.html?upgraded=1`,
      cancel_url:  `${FRONTEND_URL()}/upgrade.html?canceled=1`,
      metadata:    { userId: String(user.id), plan: planType },
      subscription_data: {
        metadata: { userId: String(user.id), plan: planType },
      },
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to create checkout session.' });
  }
});

// ── GET /api/billing/portal ───────────────────────────────────────────────────
// Creates a Stripe Customer Portal session so the user can manage their
// subscription, update payment method, or cancel — without us building any of
// that from scratch.
router.get('/portal', requireAuth, async (req, res) => {
  try {
    const stripe = getStripe();
    const user   = req.user;

    if (!user.stripe_customer_id) {
      return res.status(400).json({ success: false, message: 'No active subscription found.' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripe_customer_id,
      return_url: `${FRONTEND_URL()}/my-profile.html`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err.message);
    return res.status(500).json({ success: false, message: 'Failed to open billing portal.' });
  }
});

// ── GET /api/billing/status ───────────────────────────────────────────────────
// Returns the current plan and subscription status for the authenticated user.
router.get('/status', requireAuth, (req, res) => {
  return res.json({
    plan:                req.user.plan || 'free',
    subscription_status: req.user.subscription_status || 'free',
    stripe_customer_id:  req.user.stripe_customer_id || null,
  });
});

// ── Webhook handler (exported separately — registered in index.js) ─────────────
// express.raw() must be applied to this route BEFORE express.json() runs.
async function webhookHandler(req, res) {
  const sig    = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET is not set');
    return res.status(500).end();
  }

  let event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`[Stripe] ${event.type}`);

  try {
    switch (event.type) {

      // ── Payment completed via Checkout ──────────────────────────────────
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.payment_status !== 'paid') break;

        const userId   = parseInt(session.client_reference_id, 10);
        if (!userId) { console.error('Webhook: no client_reference_id'); break; }

        // Determine which plan was purchased from session metadata
        const planType = session.metadata?.plan === 'cross_campus' ? 'cross_campus' : 'premium';

        await run(
          `UPDATE users
           SET plan=$1, subscription_status='active',
               stripe_customer_id=$2, stripe_subscription_id=$3
           WHERE id=$4`,
          [planType, session.customer, session.subscription, userId]
        );
        console.log(`[Stripe] Activated ${planType} for user ${userId}`);
        break;
      }

      // ── Subscription status changed (renewal, upgrade, downgrade) ───────
      case 'customer.subscription.updated': {
        const sub    = event.data.object;
        const status = sub.status; // active | trialing | past_due | canceled | unpaid

        if (status === 'active' || status === 'trialing') {
          // Preserve the existing plan tier (premium vs cross_campus) — don't downgrade it
          // just because of a renewal. Only change if the subscription's metadata says otherwise.
          const planFromMeta = sub.metadata?.plan;
          const planSql = planFromMeta
            ? `, plan='${planFromMeta === 'cross_campus' ? 'cross_campus' : 'premium'}'`
            : ''; // no plan change on simple renewals
          await run(
            `UPDATE users SET subscription_status=$1, stripe_subscription_id=$2${planSql} WHERE stripe_customer_id=$3`,
            [status, sub.id, sub.customer]
          );
        } else {
          // Non-active status (past_due, unpaid, etc.) — downgrade to free
          await run(
            `UPDATE users SET plan='free', subscription_status=$1, stripe_subscription_id=$2 WHERE stripe_customer_id=$3`,
            [status, sub.id, sub.customer]
          );
        }
        console.log(`[Stripe] Subscription ${sub.id} → ${status}`);
        break;
      }

      // ── Subscription canceled / deleted ──────────────────────────────────
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await run(
          `UPDATE users
           SET plan='free', subscription_status='canceled', stripe_subscription_id=NULL
           WHERE stripe_customer_id=$1`,
          [sub.customer]
        );
        console.log(`[Stripe] Subscription ${sub.id} deleted → downgraded to free`);
        break;
      }

      // ── Payment failed ────────────────────────────────────────────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        console.warn(`[Stripe] Payment failed for customer ${invoice.customer} — invoice ${invoice.id}`);
        // Don't immediately revoke premium on first failure; Stripe will retry
        // and send subscription.updated with status=past_due when appropriate.
        break;
      }

      default:
        // Unhandled event type — log and ignore
        break;
    }
  } catch (err) {
    console.error('Webhook handler error:', err.message);
    // Still return 200 so Stripe doesn't keep retrying for a permanent error
  }

  return res.json({ received: true });
}

// ── RevenueCat webhook handler ─────────────────────────────────────────────────
// RevenueCat sends a Bearer token you set in their dashboard (Integrations →
// Webhooks). Store it as REVENUECAT_WEBHOOK_SECRET in your .env file.
//
// Events that activate premium : INITIAL_PURCHASE, RENEWAL, UNCANCELLATION
// Events that downgrade to free : CANCELLATION, EXPIRATION, BILLING_ISSUE
async function revenuecatWebhookHandler(req, res) {
  const auth   = req.headers['authorization'];
  const secret = process.env.REVENUECAT_WEBHOOK_SECRET;

  if (secret && auth !== `Bearer ${secret}`) {
    console.error('[RevenueCat] Webhook authorization failed');
    return res.status(401).end();
  }

  let body;
  try {
    body = JSON.parse(req.body.toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const event  = body.event;
  const userId = parseInt(event?.app_user_id, 10);

  if (!userId || isNaN(userId)) {
    console.error('[RevenueCat] Webhook missing app_user_id:', event?.app_user_id);
    return res.status(400).json({ error: 'Missing app_user_id' });
  }

  console.log(`[RevenueCat] ${event.type} for user ${userId}`);

  try {
    switch (event.type) {
      case 'INITIAL_PURCHASE':
      case 'RENEWAL':
      case 'UNCANCELLATION':
      case 'PRODUCT_CHANGE':
        await run(
          `UPDATE users
           SET plan='premium', subscription_status='active',
               revenuecat_customer_id=$1
           WHERE id=$2`,
          [event.app_user_id, userId]
        );
        console.log(`[RevenueCat] Activated premium for user ${userId}`);
        break;

      case 'CANCELLATION':
        // Cancellation = user cancelled, but they keep premium until period ends.
        // RevenueCat will send EXPIRATION when access actually ends.
        // We only downgrade on EXPIRATION so they don't lose access early.
        await run(
          `UPDATE users SET subscription_status='canceled' WHERE id=$1`,
          [userId]
        );
        break;

      case 'EXPIRATION':
      case 'BILLING_ISSUE':
        await run(
          `UPDATE users SET plan='free', subscription_status=$1 WHERE id=$2`,
          [event.type === 'EXPIRATION' ? 'expired' : 'billing_issue', userId]
        );
        console.log(`[RevenueCat] Downgraded user ${userId} to free (${event.type})`);
        break;

      default:
        break;
    }
  } catch (err) {
    console.error('[RevenueCat] Webhook handler error:', err.message);
  }

  return res.json({ received: true });
}

module.exports = { router, webhookHandler, revenuecatWebhookHandler };
