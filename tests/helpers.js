'use strict';

const { loadConfig } = require('../server/config');
const { openDatabase } = require('../server/db');

// إعدادات ثابتة للاختبار: توقيت +03:00 ومدير بكلمة مرور معروفة
function testConfig(overrides = {}) {
  const config = loadConfig({
    SHOP_UTC_OFFSET: '+03:00',
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'secret-pass',
    REMINDER_MINUTES: '60',
    DEFAULT_COUNTRY_CODE: '966',
    OWNER_PHONE: '+966500000001',
    ...overrides.env,
  });
  return { ...config, ...overrides.config, reminders: { ...config.reminders, ...overrides.config?.reminders } };
}

function memoryDb() {
  return openDatabase(':memory:');
}

function addTechnician(db, name, phone) {
  return Number(
    db
      .prepare('INSERT INTO technicians (name, phone, active, created_at) VALUES (?, ?, 1, ?)')
      .run(name, phone, new Date().toISOString()).lastInsertRowid,
  );
}

// الساعة 08:00 صباحاً بتوقيت المحل يوم 16 أكتوبر 2026
const FIXED_NOW = new Date('2026-10-16T05:00:00Z');

// يحل سؤال التحدي "كم يساوي 3 + 4؟" ويعيد الإجابة
function solveCaptcha(question) {
  const m = /(\d+) ([+−]) (\d+)/.exec(question);
  const a = Number(m[1]);
  const b = Number(m[3]);
  return String(m[2] === '+' ? a + b : a - b);
}

module.exports = { testConfig, memoryDb, addTechnician, FIXED_NOW, solveCaptcha };
