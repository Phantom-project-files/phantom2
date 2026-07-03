// lib/entitlement.js — the single paid/unlocked check (v1 lesson: generation
// must NEVER run unpaid by accident; the gate is one function so Stripe's
// arrival later swaps internals, not call sites).

export function isEntitled(intake) {
  return !!intake && ['paid', 'admin_override'].includes(intake.payment_status);
}

export function requireEntitledIntake(intakesAccessor) {
  return (req, res, next) => {
    const intake = intakesAccessor.byId(req.params.id || req.params.intakeId);
    if (!intake) return res.status(404).json({ success: false, error: 'intake not found' });
    if (!isEntitled(intake)) {
      return res.status(402).json({ success: false, error: 'payment required', payment_status: intake.payment_status });
    }
    req.intake = intake;
    next();
  };
}
