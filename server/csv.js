'use strict';

const { acTypeLabel, slotLabel } = require('./domain');
const { mapLink } = require('./notifications');

const COLUMNS = [
  ['رقم الحجز', (b) => b.reference],
  ['الحالة', (b) => b.status],
  ['التاريخ', (b) => b.date],
  ['الموعد', (b) => slotLabel(b.slot)],
  ['العميل', (b) => b.customerName],
  ['الجوال', (b) => b.customerPhone],
  ['نوع المكيف', (b) => acTypeLabel(b.acType)],
  ['العنوان', (b) => b.address],
  ['خط العرض', (b) => b.latitude ?? ''],
  ['خط الطول', (b) => b.longitude ?? ''],
  ['رابط الخريطة', (b) => mapLink(b)],
  ['الفني', (b) => b.technicianName ?? ''],
  ['ملاحظات', (b) => b.notes],
  ['تاريخ الإنشاء', (b) => b.createdAt],
];

// حماية من حقن الصيغ في Excel: أي خلية تبدأ بمحرف صيغة تُسبق بـ '
function escapeCell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

// BOM في البداية حتى يقرأ Excel العربية بشكل صحيح
function bookingsToCsv(bookings) {
  const header = COLUMNS.map(([title]) => escapeCell(title)).join(',');
  const rows = bookings.map((b) => COLUMNS.map(([, get]) => escapeCell(get(b))).join(','));
  return `﻿${[header, ...rows].join('\r\n')}\r\n`;
}

module.exports = { bookingsToCsv, escapeCell };
