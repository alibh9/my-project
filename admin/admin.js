'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);

  const state = { slots: [], acTypes: [], statuses: { confirmed: 'مؤكد', completed: 'مكتمل', cancelled: 'ملغي' }, technicians: [] };

  // ---------- أدوات ----------

  async function api(url, options = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      ...options,
    });
    let data = {};
    try { data = await res.json(); } catch { /* ليس JSON */ }
    if (!res.ok) {
      const err = new Error(data.error || `خطأ ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function flashError(message) {
    const box = $('#globalError');
    box.textContent = message;
    box.hidden = !message;
    if (message) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const addDaysIso = (iso, days) => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'value') node.value = v;
      else node.setAttribute(k, v);
    }
    if (text != null) node.textContent = text;
    return node;
  }

  function option(value, label, selected) {
    const o = el('option', { value }, label);
    if (selected) o.selected = true;
    return o;
  }

  // ---------- تحميل الإعدادات والفنيين ----------

  async function loadConfig() {
    const cfg = await api('/api/config');
    state.slots = cfg.slots;
    state.acTypes = cfg.acTypes;
    $('#reportDate').value = cfg.today;
    const from = $('#filters [name=from]');
    const to = $('#filters [name=to]');
    from.value = cfg.today;
    to.value = addDaysIso(cfg.today, 7);
  }

  async function loadTechnicians() {
    const { technicians } = await api('/api/admin/technicians');
    state.technicians = technicians;
    renderTechnicians();

    const filterTech = $('#filterTech');
    const current = filterTech.value;
    filterTech.innerHTML = '';
    filterTech.append(option('', 'الكل'));
    filterTech.append(option('none', 'بدون فني'));
    for (const t of technicians.filter((x) => x.active)) {
      filterTech.append(option(String(t.id), t.name));
    }
    filterTech.value = current || '';
  }

  // ---------- الحجوزات ----------

  function acLabel(id) {
    return state.acTypes.find((t) => t.id === id)?.label ?? id;
  }

  // يحوّل "customer=ok;owner=failed" إلى سطر عربي مقروء
  function notifyLine(summary) {
    const names = { customer: 'العميل', owner: 'المحل', technician: 'الفني' };
    const states = { ok: '✓', failed: '✗ فشل', skipped: '—' };
    const parts = summary.split(';').map((pair) => {
      const [key, state] = pair.split('=');
      return `${names[key] ?? key} ${states[state] ?? state}`;
    });
    return el('span', { class: 'small-text', title: 'حالة إرسال واتساب' }, `واتساب: ${parts.join('، ')}`);
  }

  function technicianSelect(booking) {
    const sel = el('select', { 'aria-label': `فني الحجز ${booking.reference}` });
    sel.append(option('', 'تلقائي (أول فني متاح)', booking.technicianId == null));
    for (const t of state.technicians.filter((x) => x.active || x.id === booking.technicianId)) {
      sel.append(option(String(t.id), t.name + (t.active ? '' : ' (غير نشط)'), t.id === booking.technicianId));
    }
    return sel;
  }

  function rowFor(booking) {
    const tr = el('tr', { 'data-id': booking.id });

    // المرجع
    const refCell = el('td');
    refCell.append(el('strong', { class: 'dir-ltr' }, booking.reference));
    refCell.append(el('span', { class: 'small-text' }, `أُنشئ: ${booking.createdAt.slice(0, 16).replace('T', ' ')}`));
    if (booking.reminderSent) refCell.append(el('span', { class: 'badge reminded' }, 'تم التذكير'));
    if (booking.notifyStatus) refCell.append(notifyLine(booking.notifyStatus));

    // الموعد: تاريخ + ساعة قابلة للتعديل
    const dateCell = el('td');
    const dateInput = el('input', { type: 'date', value: booking.date, 'aria-label': 'تاريخ الحجز' });
    const slotSel = el('select', { 'aria-label': 'موعد الحجز' });
    for (const s of state.slots) slotSel.append(option(s.time, s.label, s.time === booking.slot));
    dateCell.append(dateInput, slotSel);

    // العميل
    const custCell = el('td');
    custCell.append(el('strong', {}, booking.customerName));
    const phone = el('a', { class: 'small-text dir-ltr', href: `tel:${booking.customerPhone}` }, booking.customerPhone);
    custCell.append(phone);

    // المكيف والعنوان
    const addrCell = el('td');
    addrCell.append(el('span', {}, acLabel(booking.acType)));
    addrCell.append(el('span', { class: 'small-text' }, booking.address));
    if (booking.latitude != null) {
      const map = el('a', {
        class: 'small-text link',
        href: `https://www.google.com/maps?q=${booking.latitude},${booking.longitude}`,
        target: '_blank',
        rel: 'noopener',
      }, 'فتح الموقع على الخريطة');
      addrCell.append(map);
    }
    if (booking.notes) addrCell.append(el('span', { class: 'small-text' }, `ملاحظة: ${booking.notes}`));

    // الفني
    const techCell = el('td');
    const techSel = technicianSelect(booking);
    techCell.append(techSel);

    // الحالة
    const statusCell = el('td');
    const statusSel = el('select', { 'aria-label': 'حالة الحجز' });
    for (const [value, label] of Object.entries(state.statuses)) {
      statusSel.append(option(value, label, value === booking.status));
    }
    statusCell.append(statusSel, el('span', { class: `badge ${booking.status}` }, state.statuses[booking.status]));

    // إجراء الحفظ
    const actionCell = el('td');
    const saveBtn = el('button', { type: 'button', class: 'primary small' }, 'حفظ');
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      const patch = {
        date: dateInput.value,
        slot: slotSel.value,
        technicianId: techSel.value === '' ? null : Number(techSel.value),
        status: statusSel.value,
      };
      try {
        await api(`/api/admin/bookings/${booking.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
        flashError('');
        tr.classList.add('row-saved');
        setTimeout(() => tr.classList.remove('row-saved'), 900);
        await loadBookings();
      } catch (err) {
        flashError(`تعذر حفظ الحجز ${booking.reference}: ${err.message}`);
      } finally {
        saveBtn.disabled = false;
      }
    });
    actionCell.append(saveBtn);

    tr.append(refCell, dateCell, custCell, addrCell, techCell, statusCell, actionCell);
    return tr;
  }

  async function loadBookings(event) {
    event?.preventDefault();
    const f = new FormData($('#filters'));
    const params = new URLSearchParams();
    for (const key of ['from', 'to', 'status']) {
      const v = f.get(key);
      if (v) params.set(key, v);
    }
    // "بدون فني" يُفلتر في المتصفح لأن الخادم يفلتر بمعرّف الفني فقط
    const tech = f.get('technicianId');
    if (tech && tech !== 'none') params.set('technicianId', tech);

    $('#exportLink').href = `/api/admin/export.csv?${params}`;

    try {
      const { bookings } = await api(`/api/admin/bookings?${params}`);
      const filtered = tech === 'none' ? bookings.filter((b) => b.technicianId == null) : bookings;
      const body = $('#bookingsBody');
      body.innerHTML = '';
      if (!filtered.length) {
        const tr = el('tr');
        tr.append(el('td', { colspan: '7', class: 'muted' }, 'لا توجد حجوزات ضمن هذه الفلاتر'));
        body.append(tr);
      }
      for (const b of filtered) body.append(rowFor(b));
      $('#bookingsCount').textContent = `عدد الحجوزات: ${filtered.length}`;
    } catch (err) {
      flashError(err.message);
    }
  }

  // ---------- الفنيون ----------

  function techRow(t) {
    const tr = el('tr');
    const nameInput = el('input', { value: t.name, 'aria-label': 'اسم الفني', maxlength: '80' });
    const phoneInput = el('input', { value: t.phone, 'aria-label': 'جوال الفني', dir: 'ltr' });
    const activeBox = el('input', { type: 'checkbox', 'aria-label': 'نشط' });
    activeBox.checked = t.active;
    const save = el('button', { type: 'button', class: 'ghost' }, 'حفظ');
    save.addEventListener('click', async () => {
      try {
        await api(`/api/admin/technicians/${t.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name: nameInput.value, phone: phoneInput.value, active: activeBox.checked }),
        });
        flashError('');
        await loadTechnicians();
        await loadBookings();
      } catch (err) {
        flashError(err.message);
      }
    });
    const cells = [nameInput, phoneInput, activeBox, save].map((node) => {
      const td = el('td');
      td.append(node);
      return td;
    });
    tr.append(...cells);
    return tr;
  }

  function renderTechnicians() {
    const body = $('#techBody');
    body.innerHTML = '';
    if (!state.technicians.length) {
      const tr = el('tr');
      tr.append(el('td', { colspan: '4', class: 'muted' }, 'لا يوجد فنيون بعد. أضف أول فني من النموذج أعلاه.'));
      body.append(tr);
      return;
    }
    for (const t of state.technicians) body.append(techRow(t));
  }

  async function addTechnician(event) {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    try {
      await api('/api/admin/technicians', {
        method: 'POST',
        body: JSON.stringify({ name: f.get('name'), phone: f.get('phone') }),
      });
      event.currentTarget.reset();
      flashError('');
      await loadTechnicians();
    } catch (err) {
      flashError(err.message);
    }
  }

  // ---------- التقرير ----------

  function stat(value, label) {
    const box = el('div', { class: 'stat' });
    box.append(el('strong', {}, String(value)), el('span', {}, label));
    return box;
  }

  function listItem(label, count) {
    const li = el('li');
    li.append(el('span', {}, label), el('strong', {}, String(count)));
    return li;
  }

  async function loadReport() {
    const date = $('#reportDate').value;
    if (!date) return;
    try {
      const r = await api(`/api/admin/report?date=${date}`);
      const stats = $('#reportStats');
      stats.innerHTML = '';
      stats.append(
        stat(r.total, 'إجمالي حجوزات اليوم'),
        stat(r.byStatus.confirmed, 'مؤكدة'),
        stat(r.byStatus.completed, 'مكتملة'),
        stat(r.byStatus.cancelled, 'ملغاة'),
        stat(r.activeTechnicians, 'فنيون نشطون'),
      );

      const slots = $('#reportSlots');
      slots.innerHTML = '';
      for (const [, v] of Object.entries(r.bySlot)) slots.append(listItem(v.label, v.count));

      const ac = $('#reportAc');
      ac.innerHTML = '';
      for (const [, v] of Object.entries(r.byAcType)) ac.append(listItem(v.label, v.count));

      const tech = $('#reportTech');
      tech.innerHTML = '';
      if (!r.byTechnician.length) tech.append(el('li', { class: 'muted' }, 'لا توجد حجوزات'));
      for (const t of r.byTechnician) tech.append(listItem(t.name, t.count));
    } catch (err) {
      flashError(err.message);
    }
  }

  async function runReminders() {
    const btn = $('#remindersBtn');
    btn.disabled = true;
    try {
      const r = await api('/api/admin/reminders/run', { method: 'POST' });
      flashError('');
      window.alert(`تم فحص ${r.checked} حجز وأُرسل تذكير لـ ${r.sent}.`);
    } catch (err) {
      flashError(err.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- التهيئة ----------

  async function init() {
    try {
      await loadConfig();
      await loadTechnicians();
      await loadBookings();
      await loadReport();
    } catch (err) {
      flashError(
        err.status === 401
          ? 'بيانات الدخول غير صحيحة. أعد تحميل الصفحة وأدخل البيانات الصحيحة.'
          : err.message,
      );
    }

    $('#filters').addEventListener('submit', loadBookings);
    $('#reportBtn').addEventListener('click', loadReport);
    $('#reportDate').addEventListener('change', loadReport);
    $('#remindersBtn').addEventListener('click', runReminders);
    $('#techForm').addEventListener('submit', addTechnician);
  }

  init();
})();
