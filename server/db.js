'use strict';

const fs = require('node:fs');
const path = require('node:path');
// node:sqlite تطلق تحذيراً تجريبياً عند التحميل في Node 22. نُسكت هذا التحذير تحديداً فقط
const originalEmitWarning = process.emitWarning;
process.emitWarning = function emitWarningFiltered(warning, ...rest) {
  const message = typeof warning === 'string' ? warning : warning?.message;
  if (/SQLite is an experimental feature/.test(String(message))) return;
  return originalEmitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = originalEmitWarning;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS technicians (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    phone      TEXT    NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    reference         TEXT    NOT NULL UNIQUE,
    customer_name     TEXT    NOT NULL,
    customer_phone    TEXT    NOT NULL,
    ac_type           TEXT    NOT NULL,
    address           TEXT    NOT NULL,
    latitude          REAL,
    longitude         REAL,
    notes             TEXT    NOT NULL DEFAULT '',
    booking_date      TEXT    NOT NULL,
    slot_time         TEXT    NOT NULL,
    technician_id     INTEGER REFERENCES technicians(id),
    status            TEXT    NOT NULL DEFAULT 'confirmed',
    reminder_sent     INTEGER NOT NULL DEFAULT 0,
    notify_status     TEXT    NOT NULL DEFAULT '',
    created_at        TEXT    NOT NULL,
    updated_at        TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_date_slot ON bookings(booking_date, slot_time);
  CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);

  -- طبقة حماية ثانية على مستوى قاعدة البيانات: فني واحد لا يمكن أن يملك حجزين نشطين في نفس الموعد
  CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_technician_slot
    ON bookings(booking_date, slot_time, technician_id)
    WHERE status = 'confirmed' AND technician_id IS NOT NULL;
`;

function openDatabase(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // ترحيل لقواعد أُنشئت قبل إضافة العمود
  const columns = db.prepare('PRAGMA table_info(bookings)').all().map((c) => c.name);
  if (!columns.includes('notify_status')) {
    db.exec("ALTER TABLE bookings ADD COLUMN notify_status TEXT NOT NULL DEFAULT ''");
  }
  return db;
}

// تنفيذ دالة داخل معاملة تكتب بقفل فوري لمنع السباق بين طلبين متزامنين
function inTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { openDatabase, inTransaction };
