'use strict';

// الثوابت والمنطق الزمني المشترك. لا يعتمد على قاعدة البيانات.

const SLOTS = Object.freeze([
  Object.freeze({ time: '09:00', label: '9:00 صباحاً' }),
  Object.freeze({ time: '12:00', label: '12:00 ظهراً' }),
  Object.freeze({ time: '16:00', label: '4:00 عصراً' }),
]);

const AC_TYPES = Object.freeze([
  Object.freeze({ id: 'split', label: 'سبلت' }),
  Object.freeze({ id: 'window', label: 'وندو' }),
  Object.freeze({ id: 'ducted', label: 'دكت' }),
  Object.freeze({ id: 'central', label: 'سنترال' }),
]);

const STATUSES = Object.freeze(['confirmed', 'completed', 'cancelled']);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function acTypeLabel(id) {
  return AC_TYPES.find((t) => t.id === id)?.label ?? id;
}

function slotLabel(time) {
  return SLOTS.find((s) => s.time === time)?.label ?? time;
}

function isValidSlot(time) {
  return SLOTS.some((s) => s.time === time);
}

function offsetToMinutes(offset) {
  const sign = offset.startsWith('-') ? -1 : 1;
  const [h, m] = offset.slice(1).split(':').map(Number);
  return sign * (h * 60 + m);
}

// يعيد التاريخ "YYYY-MM-DD" حسب توقيت المحل
function shopDateOf(instant, offset) {
  const shifted = new Date(instant.getTime() + offsetToMinutes(offset) * 60000);
  return shifted.toISOString().slice(0, 10);
}

// يحوّل تاريخ + ساعة محلية إلى لحظة زمنية حقيقية
function slotInstant(date, time, offset) {
  return new Date(`${date}T${time}:00${offset}`);
}

function isRealDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  SLOTS,
  AC_TYPES,
  STATUSES,
  acTypeLabel,
  slotLabel,
  isValidSlot,
  shopDateOf,
  slotInstant,
  isRealDate,
  addDays,
  offsetToMinutes,
};
