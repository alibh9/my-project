'use strict';

const crypto = require('node:crypto');

// ---------- تحدي حسابي بسيط ضد الروبوتات ----------

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING = 5000;
const challenges = new Map();

function createCaptcha(now = Date.now()) {
  for (const [id, entry] of challenges) {
    if (entry.expiresAt < now) challenges.delete(id);
  }
  if (challenges.size >= MAX_PENDING) {
    challenges.delete(challenges.keys().next().value);
  }

  const a = crypto.randomInt(1, 10);
  const b = crypto.randomInt(1, 10);
  const subtract = crypto.randomInt(0, 2) === 1 && a > b;
  const answer = subtract ? a - b : a + b;
  const id = crypto.randomUUID();
  challenges.set(id, { answer, expiresAt: now + CHALLENGE_TTL_MS });
  return {
    id,
    question: `كم يساوي ${a} ${subtract ? '−' : '+'} ${b}؟`,
  };
}

// التحدي يُستهلك بعد أول محاولة سواء نجحت أم فشلت (لا يُعاد استخدامه)
function verifyCaptcha(id, answer, now = Date.now()) {
  const entry = challenges.get(id);
  challenges.delete(id);
  if (!entry || entry.expiresAt < now) return false;
  return Number(String(answer ?? '').trim()) === entry.answer;
}

// ---------- حد معدل الطلبات لكل IP ----------

function createRateLimiter({ windowMs, max, message }) {
  const hits = new Map();
  return function rateLimit(req, res, next) {
    const now = Date.now();
    const key = req.ip || 'unknown';
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
    }
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: message || 'طلبات كثيرة جداً، حاول لاحقاً' });
    }
    next();
  };
}

// ---------- مصادقة أساسية للوحة الإدارة ----------

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function basicAuth({ user, password }) {
  return function requireAdmin(req, res, next) {
    if (!password) {
      return res.status(503).json({ error: 'لوحة الإدارة غير مفعّلة: اضبط ADMIN_PASSWORD' });
    }
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      if (sep !== -1) {
        const u = decoded.slice(0, sep);
        const p = decoded.slice(sep + 1);
        if (safeEqual(u, user) && safeEqual(p, password)) return next();
      }
    }
    // ترويسات HTTP يجب أن تكون ASCII، لذلك اسم النطاق بالإنجليزية
    res.set('WWW-Authenticate', 'Basic realm="Admin", charset="UTF-8"');
    return res.status(401).json({ error: 'بيانات الدخول غير صحيحة' });
  };
}

// ---------- ترويسات أمان ----------

function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; " +
      "connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; " +
      "base-uri 'self'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(), microphone=()',
  });
  next();
}

module.exports = {
  createCaptcha,
  verifyCaptcha,
  createRateLimiter,
  basicAuth,
  safeEqual,
  securityHeaders,
};
