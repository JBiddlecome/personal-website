// Weekly deals email, sent through Resend (the same account as the site's contact form).
// The sender is GROCERY_EMAIL_FROM, else CONTACT_FROM; Resend's default onboarding@resend.dev
// sender can only deliver to the address that owns the Resend account.
const SITE_URL = process.env.GROCERY_SITE_URL || 'https://jakebiddlecome.com/grocery';

const isConfigured = () => Boolean(process.env.RESEND_API_KEY);
const fromAddress = () => process.env.GROCERY_EMAIL_FROM || process.env.CONTACT_FROM || 'onboarding@resend.dev';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (v) => `$${Number(v || 0).toFixed(Math.abs(v) < 1 && v !== 0 ? 3 : 2)}`;
// Standard prices: per 100 g, per 100 ml, or per counted unit (see units.js).
const per = (measure, countUnit) => (measure === 'g' ? '/100 g' : measure === 'ml' ? '/100 ml' : `/${countUnit || 'item'}`);
const unit = (v, d) => (v == null ? '—' : `${money(v)}${per(d.measure, d.count_unit)}`);
const fmtDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

function dealLine(d) {
  const p = d.product;
  const pct = Math.round(p.deal.pct * 100);
  const now = Number(p.coupon?.final ?? p.promo ?? p.regular).toFixed(2);
  const std = p.unit_price != null ? ` (${unit(p.unit_price, d)})` : '';
  const vs = p.deal.kind === 'sale_no_history' ? `${pct}% off the regular $${p.regular.toFixed(2)}`
    : p.deal.kind === 'below_target' ? `${pct}% below your alert price of ${unit(d.baseline.target, d)}`
      : `${pct}% below your usual ${unit(d.baseline.usual, d)}${p.deal.sale ? '' : ' (regular price, bigger or cheaper size)'}`;
  const ends = p.coupon ? `, with digital coupon "${p.coupon.offer}"${p.coupon.expires ? ` (until ${fmtDate(p.coupon.expires)})` : ''}`
    : p.promo_expires ? `, sale ends ${fmtDate(p.promo_expires)}` : '';
  return { pct, now, per: std, vs, ends, advice: d.advice, name: d.name, product: `${p.description}${p.size ? ` (${p.size})` : ''}` };
}

// view: deals.dealsView() output. Returns { subject, html, text }.
function buildDealsEmail(view, storeName) {
  const deals = view.deals;
  const subject = deals.length
    ? `${storeName} deals: ${deals.length} item${deals.length !== 1 ? 's' : ''} below your usual price`
    : `${storeName}: no deals on your watchlist this week`;
  const lines = deals.map(dealLine);
  const checked = view.latest ? new Date(view.latest.run.finished_at || view.latest.run.started_at)
    .toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never';
  const watching = view.watch.filter((w) => w.status === 'watching').length;
  const footer = `Checked ${checked} · ${watching} items watched · deals are ${Math.round(view.threshold * 100)}% or more below what you usually pay. ${view.coupons.last_import ? `Digital coupons last imported ${new Date(view.coupons.last_import.at).toLocaleDateString('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric' })}.` : "Digital coupons aren't included yet: import them with the bookmark button on the Deals tab."}`;

  const text = [
    subject, '',
    ...(lines.length ? lines.map((l) => `• ${l.name}: $${l.now}${l.per}, ${l.vs}. ${l.advice}${l.ends}.\n  ${l.product}`) : ['Nothing on your watchlist is on sale enough to stock up this week.']),
    '', footer, `Manage the watchlist: ${SITE_URL}`
  ].join('\n');

  const rows = lines.map((l) => `<tr>
    <td style="padding:10px 12px;border-bottom:1px solid #eee">
      <strong>${esc(l.name)}</strong> <span style="background:#e6f4ea;color:#1e7b34;border-radius:4px;padding:1px 6px;font-size:12px">${l.pct}% off</span><br>
      <span style="color:#666;font-size:13px">${esc(l.product)}</span><br>
      <span style="font-size:13px">${esc(l.vs)}. <em>${esc(l.advice)}${esc(l.ends)}.</em></span>
    </td>
    <td style="padding:10px 12px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;vertical-align:top">
      <strong>$${l.now}</strong><br><span style="color:#666;font-size:12px">${esc(l.per.replace(/[()]/g, ''))}</span>
    </td></tr>`).join('');
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
    <h2 style="font-size:20px;margin:0 0 12px">${esc(subject)}</h2>
    ${rows ? `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}</table>`
      : '<p>Nothing on your watchlist is on sale enough to stock up this week.</p>'}
    <p style="color:#777;font-size:12px;margin-top:16px">${esc(footer)}</p>
    <p><a href="${esc(SITE_URL)}" style="color:#1a5fb4">Open the Deals tab</a></p>
  </div>`;
  return { subject, html, text };
}

async function sendEmail(to, { subject, html, text }) {
  if (!isConfigured()) throw Object.assign(new Error('RESEND_API_KEY is not configured.'), { status: 503 });
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: `Grocery Deals <${fromAddress()}>`, to: [to], subject, html, text })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(`Email failed (${res.status}): ${data.message || data.error || 'Resend rejected it'}`), { status: 502 });
  }
}

module.exports = { isConfigured, buildDealsEmail, sendEmail };
