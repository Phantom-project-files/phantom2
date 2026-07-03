// track.js — user-journey beacon (Phase 2). Every funnel page includes this.
// track('plan.selected', {plan:'premium'}) → POST /api/events (fire-and-forget).
// Auto-fires page.<basename> on load. The ph_sid cookie (set server-side) stitches
// the session together in the admin journey panel.
(function () {
  function send(name, props) {
    try {
      var body = JSON.stringify({ name: name, path: location.pathname, props: props || null });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' }));
      } else {
        fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true, credentials: 'same-origin' });
      }
    } catch (e) { /* never break the page for analytics */ }
  }
  window.track = send;
  var page = (location.pathname.split('/').pop() || 'index.html').replace('.html', '');
  send('page.' + page);
})();
