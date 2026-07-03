// lib/payments.js — Stripe checkout + webhook (Phase 2, test-mode until launch).
//
// No stripe SDK: two REST calls (create checkout session, verify webhook sig)
// keep the dep tree flat. STRIPE_MODE=mock (or no secret key) short-circuits to
// a fake session for $0 tests — the funnel then lands on checkout-success with
// ?mock=1 and payment is marked mock_paid via markIntakePaid().
//
// Entitlement truth: intakes.payment_status ∈ ('paid','admin_override') — see
// lib/entitlement.js. The webhook and the admin override both funnel through
// markIntakePaid() so the unlock path is single.

import crypto from 'crypto';
import { intakes, purchases, events } from './db.js';
import { tierConfig, isValidTier } from './tiers.js';
import { logEvent } from './logs.js';
import { sendEmail } from './email.js';
import * as jobs from './jobs.js';

const STRIPE_API = 'https://api.stripe.com/v1';
const mode = () => (process.env.STRIPE_MODE || (process.env.STRIPE_SECRET_KEY ? 'live' : 'mock')).toLowerCase();

function form(params, prefix = '') {
  // Stripe's nested form encoding: line_items[0][price_data][unit_amount]=...
  const out = [];
  for (const [k, v] of Object.entries(params)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') out.push(form(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.filter(Boolean).join('&');
}

export async function createCheckout({ intake, plan, baseUrl }) {
  if (!isValidTier(plan)) throw new Error(`invalid plan '${plan}'`);
  const cfg = tierConfig(plan);

  if (mode() === 'mock') {
    const sessionId = `cs_mock_${crypto.randomBytes(8).toString('hex')}`;
    purchases.create({
      intakeId: intake.id, tenantSlug: intake.tenant_slug, orgId: intake.org_id,
      plan, amountUsd: cfg.price, recurring: cfg.recurring, stripeSessionId: sessionId,
    });
    return { id: sessionId, url: `${baseUrl}/app/checkout-success.html?intake=${intake.id}&mock=1&session=${sessionId}`, mock: true };
  }

  const params = {
    mode: cfg.recurring ? 'subscription' : 'payment',
    success_url: `${baseUrl}/app/checkout-success.html?intake=${intake.id}&session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/app/plans.html?intake=${intake.id}&canceled=1`,
    client_reference_id: intake.id,
    'metadata[intake_id]': intake.id,
    'metadata[plan]': plan,
    'line_items[0][quantity]': 1,
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': cfg.price * 100,
    [`line_items[0][price_data][product_data][name]`]: `Phantom ${plan[0].toUpperCase()}${plan.slice(1)} — ${cfg.reels} reels · ${cfg.posts} posts${cfg.recurring ? ' / month' : ''}`,
    ...(cfg.recurring ? { 'line_items[0][price_data][recurring][interval]': 'month' } : {}),
  };
  const r = await fetch(`${STRIPE_API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form(params),
  });
  const session = await r.json();
  if (!r.ok) throw new Error(`stripe ${r.status}: ${session?.error?.message || 'checkout create failed'}`);
  purchases.create({
    intakeId: intake.id, tenantSlug: intake.tenant_slug, orgId: intake.org_id,
    plan, amountUsd: cfg.price, recurring: cfg.recurring, stripeSessionId: session.id,
  });
  logEvent({ event: 'stripe.checkout_created', tenantSlug: intake.tenant_slug, refId: session.id, message: `${plan} $${cfg.price}` });
  return { id: session.id, url: session.url };
}

// Single unlock path — webhook, mock success, and admin override all land here.
export function markIntakePaid(intakeId, { via, plan = null, sessionId = null }) {
  const intake = intakes.byId(intakeId);
  if (!intake) throw new Error(`intake ${intakeId} not found`);
  const paymentStatus = via === 'admin_override' ? 'admin_override' : 'paid';
  intakes.patch(intakeId, {
    paymentStatus,
    plan: plan || intake.plan,
    paidAt: Math.floor(Date.now() / 1000),
  });
  if (sessionId) {
    const p = purchases.bySessionId(sessionId);
    if (p) purchases.markPaid(p.id, via === 'mock' ? 'mock_paid' : 'paid');
  }
  events.record({ tenantSlug: intake.tenant_slug, name: 'funnel.paid', props: { intakeId, via, plan: plan || intake.plan } });
  logEvent({ event: 'funnel.paid', tenantSlug: intake.tenant_slug, refId: intakeId, message: `via=${via} plan=${plan || intake.plan}` });
  sendEmail({ intakeId, template: 'payment_confirmed', tenantSlug: intake.tenant_slug });
  // BPMN: payment unlocks Agent-ScriptGen → phantoms + campaigns + calendar + briefs.
  jobs.enqueue({ kind: 'script_gen', tenantSlug: intake.tenant_slug, refKind: 'intake', refId: intakeId, payload: { intakeId }, maxAttempts: 2 });
  return intakes.byId(intakeId);
}

// Stripe webhook signature check (t=...,v1=... HMAC-SHA256 over `${t}.${payload}`).
// No secret configured (local dev) → accept unsigned, loudly.
export function verifyStripeSignature(rawBody, sigHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return { ok: true, unsigned: true };
  if (!sigHeader) return { ok: false, error: 'missing stripe-signature header' };
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=')));
  if (!parts.t || !parts.v1) return { ok: false, error: 'malformed stripe-signature header' };
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected); const b = Buffer.from(String(parts.v1));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: 'signature mismatch' };
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return { ok: false, error: 'timestamp too old' };
  return { ok: true };
}

export function handleStripeEvent(event) {
  if (event.type === 'checkout.session.completed') {
    const session = event.data?.object || {};
    const intakeId = session.metadata?.intake_id || session.client_reference_id;
    if (!intakeId) return { ok: false, error: 'no intake_id on session' };
    markIntakePaid(intakeId, { via: 'stripe', plan: session.metadata?.plan || null, sessionId: session.id });
    return { ok: true, intakeId };
  }
  logEvent({ event: 'stripe.webhook_ignored', message: event.type });
  return { ok: true, ignored: event.type };
}

export const paymentsMode = mode;
