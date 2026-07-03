// lib/email.js — agent-email skeleton (Phase 2). The BPMN's blue-dashed node:
// stage-based emails to the OAuth user, triggered by pipeline events.
//
// EMAIL_MODE:
//   mock    — DEFAULT. No network; logs + records an `email.sent` journey event
//             (so the console shows exactly which email WOULD have fired when).
//   resend  — Resend HTTP API ($RESEND_API_KEY, $EMAIL_FROM). Wire when an ESP
//             account exists; templates and triggers don't change.
//
// Sends run through the jobs queue (kind `email`, its own concurrency lane) so a
// slow/failing ESP never blocks a pipeline stage. Stage triggers live at the
// call sites (oauth claim, valueprop ready, payment) — the events stream is the
// audit trail.

import { intakes, users, events } from './db.js';
import { logEvent } from './logs.js';
import * as jobs from './jobs.js';

const MODE = () => (process.env.EMAIL_MODE || 'mock').toLowerCase();
const FROM = () => process.env.EMAIL_FROM || 'Phantom <hello@online-phantom.com>';

export const TEMPLATES = {
  welcome_claimed: ({ businessName }) => ({
    subject: `${businessName} × Phantom — you're in`,
    text: `Your brand is connected. We're building your proposal now — you'll get a note the moment it's ready.`,
  }),
  proposal_ready: ({ businessName }) => ({
    subject: `Your Phantom proposal for ${businessName} is ready`,
    text: `Six AI creators, a month of content, zero effort. Your personalized proposal is live — pick a plan when you're ready.`,
  }),
  payment_confirmed: ({ businessName, plan }) => ({
    subject: `Payment confirmed — ${businessName} is in production`,
    text: `Your ${plan} plan is active. The phantoms are being cast and your first content batch is in the works. You'll review everything before it ships.`,
  }),
  month_end_report: ({ businessName, period }) => ({
    subject: `${businessName} — your ${period} content report`,
    text: `The month's numbers are in: what ran, what won, and what next month's batch will do differently because of it. Open your dashboard for the full report.`,
  }),
  upgrade_offer: ({ businessName, to }) => ({
    subject: `${businessName} is outgrowing its plan`,
    text: `Your content is earning real engagement and you're at your plan's volume ceiling. ${to ? `The ${to} tier` : 'The next tier'} puts more shots on goal — reply and we'll switch you over.`,
  }),
};

// Queue an email. Resolves the recipient from the intake's claimed user at SEND
// time (not enqueue time) so late claims still get addressed correctly.
export function sendEmail({ intakeId, template, tenantSlug = null, data = {} }) {
  if (!TEMPLATES[template]) {
    logEvent({ level: 'warn', event: 'email.unknown_template', message: template });
    return null;
  }
  return jobs.enqueue({
    kind: 'email', tenantSlug, refKind: 'intake', refId: intakeId,
    payload: { intakeId, template, data }, maxAttempts: 3,
  });
}

async function deliver({ intakeId, template, data }) {
  const intake = intakes.byId(intakeId);
  const user = intake?.claimed_user_id ? users.byId(intake.claimed_user_id) : null;
  const to = user?.email || null;
  const rendered = TEMPLATES[template]({ businessName: intake?.business_name || 'your brand', plan: intake?.plan || 'selected', ...data });

  if (!to) {
    // No claimed user yet — record the skip honestly; the trigger points re-fire post-claim.
    events.record({ tenantSlug: intake?.tenant_slug, name: 'email.skipped_no_recipient', props: { template, intakeId } });
    return { skipped: 'no recipient' };
  }

  if (MODE() === 'mock') {
    logEvent({ event: 'email.sent', tenantSlug: intake?.tenant_slug, refId: intakeId, message: `[MOCK] ${template} → ${to}: ${rendered.subject}` });
    events.record({ tenantSlug: intake?.tenant_slug, userId: user.id, name: 'email.sent', props: { template, to, mock: true } });
    return { ok: true, mock: true, to };
  }

  if (MODE() === 'resend') {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error('EMAIL_MODE=resend but RESEND_API_KEY not set');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM(), to, subject: rendered.subject, text: rendered.text }),
    });
    if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    events.record({ tenantSlug: intake?.tenant_slug, userId: user.id, name: 'email.sent', props: { template, to, id: j.id } });
    return { ok: true, id: j.id, to };
  }

  throw new Error(`unknown EMAIL_MODE '${MODE()}'`);
}

export function registerEmailJobs() {
  jobs.register('email', (payload) => deliver(payload), { concurrency: 2 });
}
