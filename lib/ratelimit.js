// Shared request limiting for the logins, the chat and the contact form. Counts live in memory, so they
// reset when the server restarts and are per-instance; that is fine for a single small server.

// How many proxies sit between the internet and this server (Railway and Render: one). Each proxy appends
// the address it saw to X-Forwarded-For, so the entry that many places from the end is the one a proxy we
// trust wrote. Everything before it is supplied by the caller and can be faked, so it is never used.
const hops = () => {
  const n = Number(process.env.TRUSTED_PROXY_HOPS ?? 1);
  return Number.isInteger(n) && n >= 0 ? n : 1;
};

function clientIp(req) {
  const socketIp = req.socket.remoteAddress || 'unknown';
  const n = hops();
  if (!n) return socketIp;
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return chain[chain.length - n] || socketIp;
}

// Sliding-window counter: at most `max` hits per key in `windowMs`.
function createLimiter({ windowMs, max }) {
  const hits = new Map();
  const recent = (key, now) => {
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length) hits.set(key, list); else hits.delete(key);
    return list;
  };
  // Drop keys that have gone quiet, so a flood of one-off addresses can't grow the map forever.
  setInterval(() => { const now = Date.now(); for (const key of hits.keys()) recent(key, now); }, Math.min(windowMs, 10 * 60 * 1000)).unref();
  return {
    blocked: (key) => recent(key, Date.now()).length >= max,
    hit(key) {
      const now = Date.now();
      const list = recent(key, now);
      list.push(now);
      hits.set(key, list);
    },
    // Counts the request and returns true if it is allowed, false if the key is already at its limit.
    take(key) {
      if (this.blocked(key)) return false;
      this.hit(key);
      return true;
    }
  };
}

// Brute-force brake for a password login: a small number of wrong passwords per address, plus a cap on
// wrong passwords from all addresses together, so guessing from thousands of addresses at once is also
// stopped. While the overall cap is reached nobody can sign in (existing sessions keep working).
function createLoginGuard({ perIp = 5, overall = 50, windowMs = 30 * 60 * 1000 } = {}) {
  const byIp = createLimiter({ windowMs, max: perIp });
  const all = createLimiter({ windowMs, max: overall });
  return {
    blocked: (ip) => byIp.blocked(ip) || all.blocked('all'),
    fail(ip) { byIp.hit(ip); all.hit('all'); }
  };
}

module.exports = { clientIp, createLimiter, createLoginGuard };
