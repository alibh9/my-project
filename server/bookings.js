'use strict';

const crypto = require('node:crypto');
const { SLOTS, STATUSES, shopDateOf, slotInstant, addDays, isRealDate } = require('./domain');
const { inTransaction } = require('./db');

class BookingError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // بدون حروف ملتبسة مثل O/0 و I/1

function newReference() {
  const bytes = crypto.randomBytes(8);
  let ref = 'AC-';
  for (const b of bytes) ref += REF_ALPHABET[b % REF_ALPHABET.length];
  return ref;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference: row.reference,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    acType: row.ac_type,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    notes: row.notes,
    date: row.booking_date,
    slot: row.slot_time,
    technicianId: row.technician_id,
    technicianName: row.technician_name ?? null,
    technicianPhone: row.technician_phone ?? null,
    status: row.status,
    reminderSent: row.reminder_sent === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_BOOKING = `
  SELECT b.*, t.name AS technician_name, t.phone AS technician_phone
  FROM bookings b
  LEFT JOIN technicians t ON t.id = b.technician_id
`;

function getBooking(db, id) {
  return mapRow(db.prepare(`${SELECT_BOOKING} WHERE b.id = ?`).get(id));
}

function activeTechnicians(db) {
  return db.prepare('SELECT id, name, phone FROM technicians WHERE active = 1 ORDER BY id').all();
}

// سعة الموعد = عدد الفنيين النشطين (أو 1 إذا لم يوجد فنيون بعد)
function slotCapacity(db) {
  return Math.max(1, activeTechnicians(db).length);
}

function occupiedBookings(db, date, slot, excludeId) {
  return db
    .prepare(
      `SELECT id, technician_id FROM bookings
       WHERE booking_date = ? AND slot_time = ? AND status = 'confirmed' AND id != ?`,
    )
    .all(date, slot, excludeId ?? -1);
}

// يتحقق من إمكانية الحجز ويختار فنياً متاحاً. يرمي BookingError عند التعارض.
function resolveTechnician(db, { date, slot, excludeId, requestedTechnicianId }) {
  const techs = activeTechnicians(db);
  const occupied = occupiedBookings(db, date, slot, excludeId);

  if (occupied.length >= Math.max(1, techs.length)) {
    throw new BookingError('SLOT_UNAVAILABLE', 'هذا الموعد محجوز بالكامل. اختر موعداً آخر');
  }

  const busy = new Set(occupied.map((o) => o.technician_id));

  if (requestedTechnicianId != null) {
    if (busy.has(requestedTechnicianId)) {
      throw new BookingError('TECHNICIAN_BUSY', 'الفني مرتبط بحجز آخر في نفس الموعد');
    }
    return requestedTechnicianId;
  }

  if (techs.length === 0) return null;
  const free = techs.find((t) => !busy.has(t.id));
  return free ? free.id : null;
}

function assertBookable(db, { date, slot, now, config }) {
  if (!isRealDate(date)) throw new BookingError('INVALID_DATE', 'تاريخ غير صحيح', 400);
  if (!SLOTS.some((s) => s.time === slot)) throw new BookingError('INVALID_SLOT', 'موعد غير صحيح', 400);

  const today = shopDateOf(now, config.timezoneOffset);
  if (date < today) throw new BookingError('PAST_SLOT', 'هذا الموعد قد مضى', 400);
  if (date === today && slotInstant(date, slot, config.timezoneOffset) <= now) {
    throw new BookingError('PAST_SLOT', 'هذا الموعد قد مضى', 400);
  }
  if (date > addDays(today, config.maxAdvanceDays)) {
    throw new BookingError('TOO_FAR', 'التاريخ بعيد أكثر من المسموح', 400);
  }
}

function isUniqueViolation(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message));
}

// إنشاء حجز: كل شيء داخل معاملة واحدة، فالتحقق والإدراج لا يمكن أن يتداخلا مع طلب آخر
function createBooking(db, input, { now, config }) {
  return inTransaction(db, () => {
    assertBookable(db, { date: input.date, slot: input.slot, now, config });
    const technicianId = resolveTechnician(db, {
      date: input.date,
      slot: input.slot,
      excludeId: null,
      requestedTechnicianId: null,
    });

    const stamp = now.toISOString();
    const reference = newReference();
    try {
      const result = db
        .prepare(
          `INSERT INTO bookings
           (reference, customer_name, customer_phone, ac_type, address, latitude, longitude,
            notes, booking_date, slot_time, technician_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
        )
        .run(
          reference,
          input.customerName,
          input.customerPhone,
          input.acType,
          input.address,
          input.latitude,
          input.longitude,
          input.notes ?? '',
          input.date,
          input.slot,
          technicianId,
          stamp,
          stamp,
        );
      return getBooking(db, Number(result.lastInsertRowid));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BookingError('SLOT_UNAVAILABLE', 'هذا الموعد تم حجزه للتو. اختر موعداً آخر');
      }
      throw error;
    }
  });
}

// تعديل من لوحة الإدارة: يعيد فحص التعارض دون احتساب الحجز نفسه
function updateBooking(db, id, patch, { now, config }) {
  return inTransaction(db, () => {
    const current = getBooking(db, id);
    if (!current) throw new BookingError('NOT_FOUND', 'الحجز غير موجود', 404);

    const next = {
      date: patch.date ?? current.date,
      slot: patch.slot ?? current.slot,
      status: patch.status ?? current.status,
      notes: patch.notes ?? current.notes,
      technicianId: 'technicianId' in patch ? patch.technicianId : current.technicianId,
    };

    if (!STATUSES.includes(next.status)) throw new BookingError('INVALID_STATUS', 'حالة غير صحيحة', 400);

    const timeChanged = next.date !== current.date || next.slot !== current.slot;
    const reactivated = next.status === 'confirmed' && current.status !== 'confirmed';

    if (next.status === 'confirmed' && (timeChanged || reactivated)) {
      assertBookable(db, { date: next.date, slot: next.slot, now, config });
    }

    if (next.status === 'confirmed') {
      const occupied = occupiedBookings(db, next.date, next.slot, id);
      if (occupied.length >= slotCapacity(db)) {
        throw new BookingError('SLOT_UNAVAILABLE', 'الموعد المختار محجوز بالكامل');
      }
      if (next.technicianId != null) {
        const busy = occupied.some((o) => o.technician_id === next.technicianId);
        if (busy) throw new BookingError('TECHNICIAN_BUSY', 'الفني مرتبط بحجز آخر في هذا الموعد');
      } else {
        next.technicianId = resolveTechnician(db, {
          date: next.date,
          slot: next.slot,
          excludeId: id,
          requestedTechnicianId: null,
        });
      }
    }

    // عند تغيير الموعد يُعاد تعيين التنبيه ليصل تذكير للموعد الجديد
    const reminderSent = timeChanged ? 0 : current.reminderSent ? 1 : 0;

    try {
      db.prepare(
        `UPDATE bookings
         SET booking_date = ?, slot_time = ?, status = ?, notes = ?, technician_id = ?,
             reminder_sent = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        next.date,
        next.slot,
        next.status,
        next.notes,
        next.technicianId ?? null,
        reminderSent,
        now.toISOString(),
        id,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BookingError('TECHNICIAN_BUSY', 'الفني مرتبط بحجز آخر في هذا الموعد');
      }
      throw error;
    }
    return getBooking(db, id);
  });
}

// توفر اليوم الواحد: كل موعد مع حالة إتاحته
function dayAvailability(db, date, { now, config }) {
  const today = shopDateOf(now, config.timezoneOffset);
  const capacity = slotCapacity(db);
  const counts = new Map(
    db
      .prepare(
        `SELECT slot_time, COUNT(*) AS n FROM bookings
         WHERE booking_date = ? AND status = 'confirmed' GROUP BY slot_time`,
      )
      .all(date)
      .map((r) => [r.slot_time, Number(r.n)]),
  );

  const slots = SLOTS.map((s) => {
    const isPast =
      date < today || (date === today && slotInstant(date, s.time, config.timezoneOffset) <= now);
    const taken = (counts.get(s.time) ?? 0) >= capacity;
    return { time: s.time, label: s.label, available: !isPast && !taken };
  });
  return { date, slots };
}

// حالة اليوم في التقويم الشهري
function monthAvailability(db, month, { now, config }) {
  const first = `${month}-01`;
  const today = shopDateOf(now, config.timezoneOffset);
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
  const last = `${month}-${String(lastDay).padStart(2, '0')}`;
  const capacity = slotCapacity(db);

  const counts = new Map();
  for (const r of db
    .prepare(
      `SELECT booking_date, slot_time, COUNT(*) AS n FROM bookings
       WHERE booking_date BETWEEN ? AND ? AND status = 'confirmed'
       GROUP BY booking_date, slot_time`,
    )
    .all(first, last)) {
    const key = r.booking_date;
    counts.set(key, (counts.get(key) ?? new Map()).set(r.slot_time, Number(r.n)));
  }

  const days = {};
  for (let day = 1; day <= lastDay; day++) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const dayCounts = counts.get(date) ?? new Map();
    const openSlots = SLOTS.filter((s) => {
      if (date < today) return false;
      if (date === today && slotInstant(date, s.time, config.timezoneOffset) <= now) return false;
      return (dayCounts.get(s.time) ?? 0) < capacity;
    }).length;

    let status;
    if (date < today) status = 'past';
    else if (date > addDays(today, config.maxAdvanceDays)) status = 'unavailable';
    else if (openSlots === 0) status = 'full';
    else if (openSlots < SLOTS.length) status = 'partial';
    else status = 'free';

    days[date] = { status, openSlots };
  }
  return days;
}

function listBookings(db, { from, to, status, technicianId } = {}) {
  const where = [];
  const params = [];
  if (from) {
    where.push('b.booking_date >= ?');
    params.push(from);
  }
  if (to) {
    where.push('b.booking_date <= ?');
    params.push(to);
  }
  if (status) {
    where.push('b.status = ?');
    params.push(status);
  }
  if (technicianId != null) {
    where.push('b.technician_id = ?');
    params.push(technicianId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db
    .prepare(`${SELECT_BOOKING} ${clause} ORDER BY b.booking_date, b.slot_time, b.id`)
    .all(...params)
    .map(mapRow);
}

function confirmedBookingsBetween(db, from, to) {
  return db
    .prepare(`${SELECT_BOOKING} WHERE b.status = 'confirmed' AND b.booking_date BETWEEN ? AND ?`)
    .all(from, to)
    .map(mapRow);
}

function markReminderSent(db, id) {
  db.prepare('UPDATE bookings SET reminder_sent = 1 WHERE id = ?').run(id);
}

module.exports = {
  BookingError,
  createBooking,
  updateBooking,
  getBooking,
  listBookings,
  dayAvailability,
  monthAvailability,
  confirmedBookingsBetween,
  markReminderSent,
  activeTechnicians,
};
