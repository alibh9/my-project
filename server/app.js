'use strict';

const path = require('node:path');
const express = require('express');
const { SLOTS, AC_TYPES, isRealDate, shopDateOf, slotLabel, acTypeLabel } = require('./domain');
const { BookingError, createBooking, dayAvailability, monthAvailability } = require('./bookings');
const { validateBookingInput } = require('./validation');
const { createCaptcha, verifyCaptcha, createRateLimiter, securityHeaders, basicAuth } = require('./security');
const { notifyBookingConfirmed, mapLink } = require('./notifications');
const { adminRouter } = require('./admin-routes');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function publicBookingView(booking) {
  return {
    reference: booking.reference,
    date: booking.date,
    slot: booking.slot,
    slotLabel: slotLabel(booking.slot),
    acType: booking.acType,
    acTypeLabel: acTypeLabel(booking.acType),
    address: booking.address,
    mapUrl: mapLink(booking),
  };
}

function createApp({ db, config, notifier, logger = console, now = () => new Date() }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);

  const bookingLimiter = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 15,
    message: 'محاولات حجز كثيرة، حاول بعد بضع دقائق',
  });
  const readLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120 });

  // ---------- واجهة برمجية عامة ----------
  const api = express.Router();
  api.use(express.json({ limit: '16kb' }));

  api.get('/config', (req, res) => {
    res.json({
      shop: config.shop,
      slots: SLOTS,
      acTypes: AC_TYPES,
      maxAdvanceDays: config.maxAdvanceDays,
      today: shopDateOf(now(), config.timezoneOffset),
    });
  });

  api.get('/captcha', readLimiter, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(createCaptcha(now().getTime()));
  });

  api.get('/availability', readLimiter, (req, res) => {
    const { month, date } = req.query;
    if (date !== undefined) {
      if (!isRealDate(date)) return res.status(400).json({ error: 'تاريخ غير صحيح' });
      return res.json(dayAvailability(db, date, { now: now(), config }));
    }
    if (month !== undefined) {
      if (!MONTH_RE.test(month)) return res.status(400).json({ error: 'صيغة الشهر غير صحيحة' });
      return res.json({ month, days: monthAvailability(db, month, { now: now(), config }) });
    }
    return res.status(400).json({ error: 'حدد month أو date' });
  });

  api.post('/bookings', bookingLimiter, async (req, res) => {
    const body = req.body ?? {};

    // حقل مصيدة مخفي: الروبوتات تملؤه والبشر لا يرونه
    if (body.website) return res.status(400).json({ error: 'تعذر إكمال الطلب' });

    const today = shopDateOf(now(), config.timezoneOffset);
    const { errors, input } = validateBookingInput(body, {
      today,
      maxAdvanceDays: config.maxAdvanceDays,
      defaultCountryCode: config.defaultCountryCode,
    });

    // التحدي يُستهلك عند التحقق، لذلك لا نستهلكه إلا إذا كانت بقية الحقول صحيحة
    if (!Object.keys(errors).length && !verifyCaptcha(body.captchaId, body.captchaAnswer, now().getTime())) {
      errors.captcha = 'إجابة التحقق غير صحيحة، جرّب السؤال الجديد';
    }
    if (Object.keys(errors).length) {
      return res.status(400).json({ error: 'راجع الحقول المحددة', errors });
    }

    const booking = createBooking(db, input, { now: now(), config });
    const notifications = await notifyBookingConfirmed(booking, { notifier, config });
    logger.info(`[booking] تم الحجز ${booking.reference} ${booking.date} ${booking.slot}`);

    return res.status(201).json({ booking: publicBookingView(booking), notifications });
  });

  app.use('/api', api);
  app.use('/api/admin', adminRouter({ db, config, notifier, logger, now }));

  // ---------- لوحة الإدارة: محمية بالكامل بما فيها الملفات ----------
  app.use('/admin', basicAuth(config.admin), express.static(config.adminDir, { index: 'index.html' }));

  // ---------- الواجهة العامة (PWA) ----------
  app.use(
    express.static(config.publicDir, {
      index: 'index.html',
      setHeaders(res, filePath) {
        // الـ service worker يجب ألا يُخزَّن مؤقتاً حتى يصل التحديث
        if (path.basename(filePath) === 'sw.js') res.set('Cache-Control', 'no-cache');
      },
    }),
  );

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'غير موجود' });
    return res.status(404).type('text/plain; charset=utf-8').send('الصفحة غير موجودة');
  });

  // ---------- معالج الأخطاء ----------
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error instanceof BookingError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') {
      return res.status(400).json({ error: 'البيانات المرسلة غير صالحة' });
    }
    logger.error(`[error] ${error.stack || error.message}`);
    return res.status(500).json({ error: 'حدث خطأ غير متوقع، حاول مرة أخرى' });
  });

  return app;
}

module.exports = { createApp, publicBookingView };
