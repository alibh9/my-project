'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);

  const form = $('#bookingForm');
  const state = {
    config: null,
    month: null, // { year, month } بتوقيت المحل
    days: {},
    date: null,
    slot: null,
    acType: null,
    submitting: false,
  };

  const pad = (n) => String(n).padStart(2, '0');
  const toIso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const monthKey = ({ year, month }) => `${year}-${pad(month)}`;

  // ---------- أدوات مساعدة ----------

  async function api(url, options) {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...(options?.body ? { 'Content-Type': 'application/json' } : {}) },
      ...options,
    });
    let data = {};
    try { data = await res.json(); } catch { /* رد غير JSON */ }
    if (!res.ok) {
      const err = new Error(data.error || 'حدث خطأ');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function showError(id, message) {
    const el = document.getElementById(`err-${id}`);
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
    const input = document.getElementById(id);
    if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
  }

  function clearErrors() {
    form.querySelectorAll('.error').forEach((el) => { el.hidden = true; el.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach((el) => el.setAttribute('aria-invalid', 'false'));
    $('#formError').hidden = true;
  }

  function formatDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Intl.DateTimeFormat('ar', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      .format(new Date(Date.UTC(y, m - 1, d)));
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  // نسخة خفيفة من محلل الإحداثيات في الخادم، تُستخدم لعرض رابط الخريطة فقط
  function parseCoordsClient(text) {
    const m = /@?(-?\d{1,3}(?:\.\d+)?)\s*[,،]\s*(-?\d{1,3}(?:\.\d+)?)/.exec(text || '');
    if (!m) return null;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
  }

  function updateMapLink() {
    const coords = parseCoordsClient($('#location').value);
    const link = $('#mapLink');
    if (coords) {
      link.href = `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
  }

  // ---------- نوع المكيف ----------

  function renderAcTypes() {
    const wrap = $('#acTypes');
    wrap.innerHTML = '';
    for (const t of state.config.acTypes) {
      const label = document.createElement('label');
      label.className = 'ac-option';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'acType';
      input.value = t.id;
      input.addEventListener('change', () => {
        state.acType = t.id;
        showError('acType', '');
      });
      const span = document.createElement('span');
      span.textContent = t.label;
      label.append(input, span);
      wrap.appendChild(label);
    }
  }

  // ---------- التقويم ----------

  function renderWeekdays() {
    const names = ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];
    $('#weekdays').innerHTML = names.map((n) => `<span>${n}</span>`).join('');
  }

  async function renderMonth() {
    const { year, month } = state.month;
    $('#monthTitle').textContent = new Intl.DateTimeFormat('ar', { month: 'long', year: 'numeric' })
      .format(new Date(Date.UTC(year, month - 1, 1)));

    const cal = $('#calendar');
    cal.setAttribute('aria-busy', 'true');
    try {
      const data = await api(`/api/availability?month=${monthKey(state.month)}`);
      state.days = data.days;
    } catch (err) {
      showError('date', err.message);
      state.days = {};
    }

    const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0 = أحد
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const today = state.config.today;

    cal.innerHTML = '';
    for (let i = 0; i < firstWeekday; i++) {
      const blank = document.createElement('span');
      blank.className = 'day blank';
      cal.appendChild(blank);
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const iso = toIso(year, month, d);
      const info = state.days[iso] || { status: 'unavailable', openSlots: 0 };
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `day ${info.status}${iso === today ? ' today' : ''}`;
      btn.dataset.date = iso;
      btn.textContent = d;

      const bookable = info.status === 'free' || info.status === 'partial';
      btn.disabled = !bookable;
      btn.setAttribute('aria-pressed', String(state.date === iso));

      const statusText = {
        free: `متاح ${state.config.slots.length} مواعيد`,
        partial: `متاح ${info.openSlots} من ${state.config.slots.length} مواعيد`,
        full: 'ممتلئ',
        past: 'يوم سابق',
        unavailable: 'غير متاح للحجز',
      }[info.status];
      btn.setAttribute('aria-label', `${formatDate(iso)}: ${statusText}`);

      if (bookable) {
        const small = document.createElement('small');
        small.textContent = info.status === 'free' ? 'متاح' : `${info.openSlots} متاح`;
        btn.appendChild(small);
        btn.addEventListener('click', () => selectDate(iso));
      }
      cal.appendChild(btn);
    }
    cal.removeAttribute('aria-busy');
  }

  function shiftMonth(delta) {
    let { year, month } = state.month;
    month += delta;
    if (month < 1) { month = 12; year--; }
    if (month > 12) { month = 1; year++; }
    state.month = { year, month };
    renderMonth();
  }

  // ---------- المواعيد ----------

  async function selectDate(iso) {
    state.date = iso;
    state.slot = null;
    clearErrors();
    document.querySelectorAll('.day[aria-pressed]').forEach((el) => {
      el.setAttribute('aria-pressed', String(el.dataset.date === iso));
    });

    const wrap = $('#slotsWrap');
    const slotsEl = $('#slots');
    $('#slotsTitle').textContent = `مواعيد ${formatDate(iso)}`;
    slotsEl.innerHTML = '';
    wrap.hidden = false;

    try {
      const data = await api(`/api/availability?date=${iso}`);
      renderSlots(data.slots);
    } catch (err) {
      showError('slot', err.message);
    }
    updateSummary();
  }

  function renderSlots(slots) {
    const slotsEl = $('#slots');
    slotsEl.innerHTML = '';
    for (const s of slots) {
      const label = document.createElement('label');
      label.className = 'slot';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'slot';
      input.value = s.time;
      input.disabled = !s.available;
      input.checked = state.slot === s.time;
      input.addEventListener('change', () => {
        state.slot = s.time;
        showError('slot', '');
        updateSummary();
      });
      const span = document.createElement('span');
      span.textContent = s.available ? s.label : `${s.label} (محجوز)`;
      label.append(input, span);
      slotsEl.appendChild(label);
    }
    const note = document.getElementById('slotNote');
    const hasOpen = slots.some((s) => s.available);
    note.hidden = hasOpen;
    note.textContent = hasOpen ? '' : 'لا توجد مواعيد متاحة في هذا اليوم، اختر يوماً آخر.';
  }

  function updateSummary() {
    const box = $('#summary');
    if (state.date && state.slot) {
      const label = state.config.slots.find((s) => s.time === state.slot)?.label;
      box.textContent = `الموعد المختار: ${formatDate(state.date)} - ${label}`;
      box.hidden = false;
    } else {
      box.hidden = true;
    }
  }

  // ---------- الموقع ----------

  function useCurrentLocation() {
    if (!navigator.geolocation) {
      showError('location', 'المتصفح لا يدعم تحديد الموقع');
      return;
    }
    const btn = $('#geoBtn');
    btn.disabled = true;
    btn.textContent = 'جارٍ تحديد الموقع...';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        $('#location').value = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
        showError('location', '');
        updateMapLink();
        btn.disabled = false;
        btn.textContent = '📍 استخدم موقعي الحالي';
      },
      () => {
        showError('location', 'تعذر الحصول على موقعك، تأكد من السماح بالوصول للموقع أو الصق الإحداثيات يدوياً');
        btn.disabled = false;
        btn.textContent = '📍 استخدم موقعي الحالي';
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
    );
  }

  async function copyCoordinates() {
    const raw = $('#location').value.trim();
    const coords = parseCoordsClient(raw);
    if (!coords) {
      showError('location', 'لا توجد إحداثيات صحيحة لنسخها');
      return;
    }
    const text = `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`;
    const ok = await copyText(text);
    const btn = $('#copyCoordsBtn');
    btn.textContent = ok ? 'تم النسخ ✓' : 'تعذر النسخ';
    setTimeout(() => { btn.textContent = 'نسخ'; }, 1800);
  }

  // ---------- التحقق ----------

  async function loadCaptcha() {
    const q = $('#captchaQuestion');
    q.textContent = '...';
    try {
      const data = await api('/api/captcha');
      form.dataset.captchaId = data.id;
      q.textContent = data.question;
    } catch {
      q.textContent = 'تعذر تحميل التحقق';
    }
    $('#captchaAnswer').value = '';
  }

  function validateLocal() {
    const errors = {};
    if (!state.acType) errors.acType = 'اختر نوع المكيف';
    if (!state.date) errors.date = 'اختر يوماً من التقويم';
    if (state.date && !state.slot) errors.slot = 'اختر الموعد';
    if (!$('#customerName').value.trim()) errors.customerName = 'اكتب اسمك الكامل';
    if (!$('#customerPhone').value.trim()) errors.customerPhone = 'اكتب رقم الجوال';
    if ($('#address').value.trim().length < 5) errors.address = 'اكتب العنوان التفصيلي';
    if (!$('#captchaAnswer').value.trim()) errors.captcha = 'أجب على سؤال التحقق';
    return errors;
  }

  // كل خطأ يذهب إلى عنصر <p id="err-..."> بجانب الحقل المعني
  function applyErrors(errors) {
    for (const [field, message] of Object.entries(errors)) showError(field, message);
    const first = form.querySelector('.error:not([hidden])');
    first?.closest('.field, .step')?.querySelector('input, textarea, button')?.focus();
  }

  // ---------- الإرسال ----------

  async function submitBooking(event) {
    event.preventDefault();
    if (state.submitting) return;
    clearErrors();

    const localErrors = validateLocal();
    if (Object.keys(localErrors).length) {
      applyErrors(localErrors);
      return;
    }

    const payload = {
      acType: state.acType,
      date: state.date,
      slot: state.slot,
      customerName: $('#customerName').value,
      customerPhone: $('#customerPhone').value,
      address: $('#address').value,
      location: $('#location').value,
      notes: $('#notes').value,
      captchaId: form.dataset.captchaId,
      captchaAnswer: $('#captchaAnswer').value,
      website: $('#website').value,
    };

    const btn = $('#submitBtn');
    state.submitting = true;
    btn.disabled = true;
    btn.textContent = 'جارٍ تأكيد الحجز...';

    try {
      const data = await api('/api/bookings', { method: 'POST', body: JSON.stringify(payload) });
      showSuccess(data);
    } catch (err) {
      if (err.data?.errors) {
        applyErrors(err.data.errors);
        if (err.data.errors.captcha) await loadCaptcha();
      } else if (err.data?.code === 'SLOT_UNAVAILABLE' || err.data?.code === 'TECHNICIAN_BUSY') {
        // الموعد حُجز في الأثناء: نعرض الحالة المحدثة ونطلب اختياراً جديداً
        $('#formError').textContent = `${err.message}. اختر موعداً آخر من التقويم.`;
        $('#formError').hidden = false;
        state.slot = null;
        updateSummary();
        await Promise.all([selectDate(state.date), renderMonth()]);
        await loadCaptcha();
      } else {
        $('#formError').textContent = err.message;
        $('#formError').hidden = false;
        await loadCaptcha();
      }
    } finally {
      state.submitting = false;
      btn.disabled = false;
      btn.textContent = 'تأكيد الحجز';
    }
  }

  function showSuccess({ booking, notifications }) {
    form.hidden = true;
    const section = $('#success');
    $('#successRef').textContent = booking.reference;
    $('#successSummary').textContent =
      `${formatDate(booking.date)} - ${booking.slotLabel} - ${booking.acTypeLabel}`;
    $('#successMap').href = booking.mapUrl;

    const sent = notifications?.customer;
    $('#successNotify').textContent = sent
      ? 'أرسلنا تفاصيل الحجز إلى رسالة واتساب على جوالك.'
      : 'احتفظ برقم الحجز، وسنتواصل معك لتأكيد الموعد.';

    section.hidden = false;
    section.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function resetForm() {
    form.reset();
    form.hidden = false;
    state.date = null;
    state.slot = null;
    state.acType = null;
    $('#success').hidden = true;
    $('#slotsWrap').hidden = true;
    $('#mapLink').hidden = true;
    updateSummary();
    clearErrors();
    renderMonth();
    loadCaptcha();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ---------- التهيئة ----------

  function setupInstallPrompt() {
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferred = e;
      $('#installBtn').hidden = false;
    });
    $('#installBtn').addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
      $('#installBtn').hidden = true;
    });
  }

  function registerServiceWorker() {
    const secure = location.protocol === 'https:' || location.hostname === 'localhost';
    if ('serviceWorker' in navigator && secure) {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* التطبيق يعمل بدون الكاش */ });
    }
  }

  async function init() {
    try {
      state.config = await api('/api/config');
    } catch (err) {
      $('#formError').textContent = 'تعذر تحميل بيانات الحجز. حدّث الصفحة لاحقاً.';
      $('#formError').hidden = false;
      return;
    }

    const shopName = state.config.shop.name || 'مركز المكيفات';
    document.title = `حجز موعد مكيف - ${shopName}`;
    $('#shopName').textContent = shopName;
    $('#footerShop').textContent = shopName;
    if (state.config.shop.phone) $('#footerPhone').textContent = state.config.shop.phone;

    const [y, m] = state.config.today.split('-').map(Number);
    state.month = { year: y, month: m };

    renderAcTypes();
    renderWeekdays();
    await renderMonth();
    loadCaptcha();

    $('#prevMonth').addEventListener('click', () => shiftMonth(-1));
    $('#nextMonth').addEventListener('click', () => shiftMonth(1));
    $('#geoBtn').addEventListener('click', useCurrentLocation);
    $('#copyCoordsBtn').addEventListener('click', copyCoordinates);
    $('#location').addEventListener('input', updateMapLink);
    $('#location').addEventListener('paste', () => setTimeout(updateMapLink, 0));
    $('#captchaRefresh').addEventListener('click', loadCaptcha);
    $('#newBookingBtn').addEventListener('click', resetForm);
    form.addEventListener('submit', submitBooking);

    setupInstallPrompt();
    registerServiceWorker();
  }

  init();
})();
