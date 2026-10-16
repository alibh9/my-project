'use strict';

const express = require('express');
const { STATUSES, AC_TYPES, SLOTS, isRealDate, shopDateOf } = require('./domain');
const { listBookings, updateBooking, activeTechnicians } = require('./bookings');
const { normalizePhone, cleanText } = require('./validation');
const { bookingsToCsv } = require('./csv');
const { runReminders } = require('./reminders');
const { basicAuth, createRateLimiter } = require('./security');

function adminRouter({ db, config, notifier, logger, now }) {
  const router = express.Router();

  router.use(
    createRateLimiter({
      windowMs: 15 * 60 * 1000,
      max: 600,
      message: 'محاولات كثيرة، حاول لاحقاً',
    }),
  );
  router.use(basicAuth(config.admin));

  // ---- الحجوزات ----
  router.get('/bookings', (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : undefined;
    const technicianId = req.query.technicianId ? Number(req.query.technicianId) : undefined;
    const from = isRealDate(req.query.from) ? req.query.from : undefined;
    const to = isRealDate(req.query.to) ? req.query.to : undefined;
    res.json({ bookings: listBookings(db, { from, to, status, technicianId }) });
  });

  router.patch('/bookings/:id', express.json({ limit: '4kb' }), (req, res) => {
    const id = Number(req.params.id);
    const body = req.body ?? {};
    const patch = {};

    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) return res.status(400).json({ error: 'حالة غير صحيحة' });
      patch.status = body.status;
    }
    if (body.date !== undefined) {
      if (!isRealDate(body.date)) return res.status(400).json({ error: 'تاريخ غير صحيح' });
      patch.date = body.date;
    }
    if (body.slot !== undefined) {
      if (!SLOTS.some((s) => s.time === body.slot)) return res.status(400).json({ error: 'موعد غير صحيح' });
      patch.slot = body.slot;
    }
    if (body.technicianId !== undefined) {
      // null = إعادة التعيين التلقائي لفني متاح
      patch.technicianId = body.technicianId === null ? null : Number(body.technicianId);
      if (patch.technicianId !== null && !activeTechnicians(db).some((t) => t.id === patch.technicianId)) {
        return res.status(400).json({ error: 'الفني غير موجود أو غير نشط' });
      }
    }
    if (body.notes !== undefined) {
      const notes = cleanText(body.notes);
      if (notes.length > 500) return res.status(400).json({ error: 'الملاحظات طويلة جداً' });
      patch.notes = notes;
    }

    const booking = updateBooking(db, id, patch, { now: now(), config });
    logger.info(`[admin] تحديث الحجز ${booking.reference}: ${JSON.stringify(Object.keys(patch))}`);
    res.json({ booking });
  });

  // ---- الفنيون ----
  router.get('/technicians', (req, res) => {
    const rows = db.prepare('SELECT id, name, phone, active FROM technicians ORDER BY name').all();
    res.json({
      technicians: rows.map((t) => ({ id: t.id, name: t.name, phone: t.phone, active: t.active === 1 })),
    });
  });

  router.post('/technicians', express.json({ limit: '4kb' }), (req, res) => {
    const name = cleanText(req.body?.name);
    const phone = normalizePhone(req.body?.phone, config.defaultCountryCode);
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'اسم الفني غير صحيح' });
    if (!phone) return res.status(400).json({ error: 'رقم جوال الفني غير صحيح' });
    const result = db
      .prepare('INSERT INTO technicians (name, phone, active, created_at) VALUES (?, ?, 1, ?)')
      .run(name, phone, now().toISOString());
    res.status(201).json({ technician: { id: Number(result.lastInsertRowid), name, phone, active: true } });
  });

  router.patch('/technicians/:id', express.json({ limit: '4kb' }), (req, res) => {
    const id = Number(req.params.id);
    const current = db.prepare('SELECT * FROM technicians WHERE id = ?').get(id);
    if (!current) return res.status(404).json({ error: 'الفني غير موجود' });

    const name = req.body?.name !== undefined ? cleanText(req.body.name) : current.name;
    const phone =
      req.body?.phone !== undefined ? normalizePhone(req.body.phone, config.defaultCountryCode) : current.phone;
    const active = req.body?.active !== undefined ? (req.body.active ? 1 : 0) : current.active;
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'اسم الفني غير صحيح' });
    if (!phone) return res.status(400).json({ error: 'رقم جوال الفني غير صحيح' });

    db.prepare('UPDATE technicians SET name = ?, phone = ?, active = ? WHERE id = ?').run(name, phone, active, id);
    res.json({ technician: { id, name, phone, active: active === 1 } });
  });

  // ---- التقرير اليومي ----
  router.get('/report', (req, res) => {
    const date = req.query.date ?? shopDateOf(now(), config.timezoneOffset);
    if (!isRealDate(date)) return res.status(400).json({ error: 'تاريخ غير صحيح' });

    const bookings = listBookings(db, { from: date, to: date });
    const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    const byAcType = Object.fromEntries(AC_TYPES.map((t) => [t.id, { label: t.label, count: 0 }]));
    const bySlot = Object.fromEntries(SLOTS.map((s) => [s.time, { label: s.label, count: 0 }]));
    const byTechnician = new Map();

    for (const b of bookings) {
      byStatus[b.status]++;
      if (byAcType[b.acType]) byAcType[b.acType].count++;
      if (b.status === 'confirmed' && bySlot[b.slot]) bySlot[b.slot].count++;
      const techKey = b.technicianName ?? 'غير مُعيَّن';
      byTechnician.set(techKey, (byTechnician.get(techKey) ?? 0) + 1);
    }

    res.json({
      date,
      total: bookings.length,
      byStatus,
      byAcType,
      bySlot,
      byTechnician: [...byTechnician].map(([name, count]) => ({ name, count })),
      activeTechnicians: activeTechnicians(db).length,
    });
  });

  // ---- تصدير CSV ----
  router.get('/export.csv', (req, res) => {
    const from = isRealDate(req.query.from) ? req.query.from : undefined;
    const to = isRealDate(req.query.to) ? req.query.to : undefined;
    const status = STATUSES.includes(req.query.status) ? req.query.status : undefined;
    const bookings = listBookings(db, { from, to, status });
    const name = `bookings-${from ?? 'all'}-${to ?? 'all'}.csv`;
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    res.send(bookingsToCsv(bookings));
  });

  // ---- تشغيل التنبيهات يدوياً ----
  router.post('/reminders/run', async (req, res) => {
    const result = await runReminders(db, { notifier, config, now: now(), logger });
    res.json(result);
  });

  return router;
}

module.exports = { adminRouter };
