/* Rido Taxi - booking & fare management (static, localStorage) */
(function () {
  'use strict';

  /* ---------- Config ---------- */
  var KEY = 'rido_taxi_v1';
  var RATES = {
    Mini:    { base: 50,  perKm: 12, seats: 4 },
    Sedan:   { base: 70,  perKm: 15, seats: 4 },
    SUV:     { base: 100, perKm: 20, seats: 6 },
    Premium: { base: 150, perKm: 28, seats: 4 }
  };
  var WAIT_RATE = 2;      // Rs per minute
  var NIGHT_PCT = 0.25;   // 10 PM - 6 AM surcharge
  var GST = 0.05;
  var CANCEL_FEE = 50;    // for an allocated trip

  /* ---------- State ---------- */
  var state = load();

  function emptyState() {
    return { drivers: [], vehicles: [], bookings: [], seq: { d: 0, v: 0, b: 1000 } };
  }
  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.drivers && s.vehicles && s.bookings && s.seq) return s;
    } catch (e) { /* ignore */ }
    return emptyState();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  /* ---------- Helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    return '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function moneyShort(n) {
    return '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
  }
  function fmtDate(v) {
    if (!v) return '-';
    var d = new Date(v);
    if (isNaN(d)) return '-';
    return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function nextId(kind) {
    state.seq[kind] += 1;
    var n = state.seq[kind];
    if (kind === 'd') return 'D' + String(n).padStart(3, '0');
    if (kind === 'v') return 'V' + String(n).padStart(3, '0');
    return 'B' + n;
  }
  function round2(n) { return Math.round(n * 100) / 100; }
  function badge(status) {
    return '<span class="badge ' + esc(status.replace(/\s/g, '')) + '">' + esc(status) + '</span>';
  }
  function localInputValue(d) {
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  var toastTimer;
  function toast(msg, isError) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }
  function findDriver(id) { return state.drivers.filter(function (d) { return d.id === id; })[0]; }
  function findVehicle(id) { return state.vehicles.filter(function (v) { return v.id === id; })[0]; }
  function findBooking(id) { return state.bookings.filter(function (b) { return b.id === id; })[0]; }

  /* ---------- Fare calculation ---------- */
  function calcFare(o) {
    var r = RATES[o.category];
    if (!r) return null;
    var dist = Math.max(0, Number(o.distance) || 0);
    var base = r.base;
    var distCharge = dist * r.perKm;
    var hour = new Date(o.datetime).getHours();
    var night = (hour >= 22 || hour < 6) ? (base + distCharge) * NIGHT_PCT : 0;
    var wait = Math.max(0, Number(o.waiting) || 0) * WAIT_RATE;
    var toll = Math.max(0, Number(o.toll) || 0);
    var taxable = base + distCharge + night + wait;
    var gst = taxable * GST;
    return {
      base: round2(base),
      distance: round2(dist),
      distCharge: round2(distCharge),
      night: round2(night),
      waiting: round2(wait),
      toll: round2(toll),
      gst: round2(gst),
      total: round2(taxable + gst + toll)
    };
  }

  function fareRows(f, withExtras) {
    var rows = '';
    rows += '<div><dt>Base fare</dt><dd>' + money(f.base) + '</dd></div>';
    rows += '<div><dt>Distance (' + f.distance + ' km)</dt><dd>' + money(f.distCharge) + '</dd></div>';
    if (f.night > 0) rows += '<div><dt>Night surcharge (25%)</dt><dd>' + money(f.night) + '</dd></div>';
    if (withExtras) {
      rows += '<div><dt>Waiting charge</dt><dd>' + money(f.waiting) + '</dd></div>';
      rows += '<div><dt>Toll / parking</dt><dd>' + money(f.toll) + '</dd></div>';
    }
    rows += '<div><dt>GST (5%)</dt><dd>' + money(f.gst) + '</dd></div>';
    rows += '<div class="total"><dt>' + (withExtras ? 'Final fare' : 'Estimated fare') + '</dt><dd>' + money(f.total) + '</dd></div>';
    return rows;
  }

  /* ---------- Navigation ---------- */
  function showView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + name); });
    document.querySelectorAll('.nav-btn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-view') === name); });
    $('nav').classList.remove('open');
    $('menuBtn').setAttribute('aria-expanded', 'false');
    window.scrollTo({ top: 0 });
    if (name === 'booking') updateEstimate();
  }

  document.addEventListener('click', function (e) {
    var nav = e.target.closest('[data-view]');
    if (nav) { e.preventDefault(); showView(nav.getAttribute('data-view')); return; }

    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    var id = btn.getAttribute('data-id');
    var handlers = {
      'drv-del': deleteDriver,
      'drv-toggle': toggleDriver,
      'veh-del': deleteVehicle,
      'veh-toggle': toggleVehicle,
      'alloc': allocate,
      'cancel': cancelBooking,
      'complete': openComplete
    };
    if (handlers[act]) handlers[act](id);
  });

  $('menuBtn').addEventListener('click', function () {
    var open = $('nav').classList.toggle('open');
    this.setAttribute('aria-expanded', String(open));
  });

  /* ---------- Rendering ---------- */
  function renderAll() {
    renderDashboard();
    renderDrivers();
    renderVehicles();
    renderAllocation();
    renderTrips();
    renderReports();
    renderPills();
  }

  function renderPills() {
    var pending = state.bookings.filter(function (b) { return b.status === 'Pending'; }).length;
    var active = state.bookings.filter(function (b) { return b.status === 'Allocated'; }).length;
    $('pendingPill').textContent = pending;
    $('activePill').textContent = active;
    $('pendingPill').classList.toggle('zero', pending === 0);
    $('activePill').classList.toggle('zero', active === 0);
  }

  function renderDashboard() {
    var completed = state.bookings.filter(function (b) { return b.status === 'Completed'; });
    var cancelled = state.bookings.filter(function (b) { return b.status === 'Cancelled'; });
    var revenue = state.bookings.reduce(function (s, b) { return s + (b.status === 'Completed' ? b.fare.total : 0); }, 0);
    $('statRevenue').textContent = moneyShort(revenue);
    $('statCompleted').textContent = completed.length;
    $('statCancelled').textContent = cancelled.length;
    $('statDrivers').textContent = state.drivers.length;
    $('statVehicles').textContent = state.vehicles.length;
    $('statPending').textContent = state.bookings.filter(function (b) { return b.status === 'Pending'; }).length;
    $('statActive').textContent = state.bookings.filter(function (b) { return b.status === 'Allocated'; }).length;

    $('rateTable').innerHTML = Object.keys(RATES).map(function (k) {
      var r = RATES[k];
      return '<tr><td class="strong">' + k + '</td><td>₹' + r.base + '</td><td>₹' + r.perKm + '</td><td>' + r.seats + '</td></tr>';
    }).join('');

    var recent = state.bookings.slice().reverse().slice(0, 5);
    $('recentTable').innerHTML = recent.length ? recent.map(function (b) {
      return '<tr><td>' + esc(b.id) + '</td><td>' + esc(b.customer) + '</td><td class="route">' +
        esc(b.pickup) + '<small>to ' + esc(b.drop) + '</small></td><td>' + badge(b.status) + '</td></tr>';
    }).join('') : '<tr><td colspan="4" class="empty">No bookings yet.</td></tr>';
  }

  function renderDrivers() {
    $('dCount').textContent = state.drivers.length;
    $('driverTable').innerHTML = state.drivers.length ? state.drivers.map(function (d) {
      var onTrip = d.status === 'On Trip';
      return '<tr><td>' + esc(d.id) + '</td><td class="strong">' + esc(d.name) + '</td><td>' + esc(d.phone) +
        '</td><td>' + esc(d.license) + '</td><td>' + esc(d.exp) + ' yr</td><td>' + badge(d.status) + '</td>' +
        '<td class="actions">' +
        '<button class="btn btn-ghost btn-sm" data-act="drv-toggle" data-id="' + esc(d.id) + '"' + (onTrip ? ' disabled' : '') + '>' +
        (d.status === 'Offline' ? 'Go online' : 'Go offline') + '</button>' +
        '<button class="btn btn-danger btn-sm" data-act="drv-del" data-id="' + esc(d.id) + '"' + (onTrip ? ' disabled' : '') + '>Delete</button>' +
        '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="empty">No drivers registered yet.</td></tr>';
  }

  function renderVehicles() {
    $('vCount').textContent = state.vehicles.length;
    $('vehicleTable').innerHTML = state.vehicles.length ? state.vehicles.map(function (v) {
      var onTrip = v.status === 'On Trip';
      return '<tr><td>' + esc(v.id) + '</td><td class="strong">' + esc(v.reg) + '</td><td>' + esc(v.model) +
        '</td><td>' + esc(v.category) + '</td><td>' + esc(v.seats) + '</td><td>' + badge(v.status) + '</td>' +
        '<td class="actions">' +
        '<button class="btn btn-ghost btn-sm" data-act="veh-toggle" data-id="' + esc(v.id) + '"' + (onTrip ? ' disabled' : '') + '>' +
        (v.status === 'Maintenance' ? 'Back in service' : 'Maintenance') + '</button>' +
        '<button class="btn btn-danger btn-sm" data-act="veh-del" data-id="' + esc(v.id) + '"' + (onTrip ? ' disabled' : '') + '>Delete</button>' +
        '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="empty">No vehicles added yet.</td></tr>';
  }

  function renderAllocation() {
    var pending = state.bookings.filter(function (b) { return b.status === 'Pending'; });
    $('allocCount').textContent = pending.length;
    var freeDrivers = state.drivers.filter(function (d) { return d.status === 'Available'; });

    $('allocTable').innerHTML = pending.length ? pending.map(function (b) {
      var vehicles = state.vehicles.filter(function (v) { return v.status === 'Available' && v.category === b.category; });
      var dOpts = '<option value="">Select driver</option>' + freeDrivers.map(function (d) {
        return '<option value="' + esc(d.id) + '">' + esc(d.name) + '</option>';
      }).join('');
      var vOpts = '<option value="">Select vehicle</option>' + vehicles.map(function (v) {
        return '<option value="' + esc(v.id) + '">' + esc(v.reg) + ' - ' + esc(v.model) + '</option>';
      }).join('');
      return '<tr><td>' + esc(b.id) + '</td><td class="strong">' + esc(b.customer) + '<small class="muted" style="display:block">' + fmtDate(b.datetime) + '</small></td>' +
        '<td class="route">' + esc(b.pickup) + '<small>to ' + esc(b.drop) + ' &middot; ' + esc(b.distance) + ' km</small></td>' +
        '<td>' + esc(b.category) + '</td>' +
        '<td><select id="alloc-d-' + esc(b.id) + '" aria-label="Driver for ' + esc(b.id) + '">' + dOpts + '</select></td>' +
        '<td><select id="alloc-v-' + esc(b.id) + '" aria-label="Vehicle for ' + esc(b.id) + '">' + vOpts + '</select></td>' +
        '<td class="actions"><button class="btn btn-primary btn-sm" data-act="alloc" data-id="' + esc(b.id) + '">Allocate</button>' +
        '<button class="btn btn-danger btn-sm" data-act="cancel" data-id="' + esc(b.id) + '">Cancel</button></td></tr>';
    }).join('') : '<tr><td colspan="7" class="empty">No bookings waiting for allocation.</td></tr>';
  }

  function renderTrips() {
    var active = state.bookings.filter(function (b) { return b.status === 'Allocated'; });
    $('tripCount').textContent = active.length;
    $('tripTable').innerHTML = active.length ? active.map(function (b) {
      return '<tr><td>' + esc(b.id) + '</td><td class="strong">' + esc(b.customer) + '<small class="muted" style="display:block">' + esc(b.phone) + '</small></td>' +
        '<td class="route">' + esc(b.pickup) + '<small>to ' + esc(b.drop) + ' &middot; ' + esc(b.distance) + ' km</small></td>' +
        '<td>' + esc(b.driverName) + '</td><td>' + esc(b.vehicleLabel) + '</td>' +
        '<td>' + money(b.estimate.total) + '</td>' +
        '<td class="actions"><button class="btn btn-primary btn-sm" data-act="complete" data-id="' + esc(b.id) + '">Complete</button>' +
        '<button class="btn btn-danger btn-sm" data-act="cancel" data-id="' + esc(b.id) + '">Cancel</button></td></tr>';
    }).join('') : '<tr><td colspan="7" class="empty">No trips in progress. Allocate a booking to start one.</td></tr>';
  }

  function history() {
    return state.bookings.filter(function (b) { return b.status === 'Completed' || b.status === 'Cancelled'; });
  }

  function renderReports() {
    var hist = history();

    // driver-wise summary
    var map = {};
    state.drivers.forEach(function (d) { map[d.id] = { name: d.name, trips: 0, done: 0, canc: 0, km: 0, earn: 0 }; });
    hist.forEach(function (b) {
      if (!b.driverId) return;
      if (!map[b.driverId]) map[b.driverId] = { name: b.driverName + ' (removed)', trips: 0, done: 0, canc: 0, km: 0, earn: 0 };
      var m = map[b.driverId];
      m.trips += 1;
      if (b.status === 'Completed') { m.done += 1; m.km += b.fare.distance; m.earn += b.fare.total; }
      else { m.canc += 1; m.earn += b.fare.total; }
    });
    var ids = Object.keys(map);
    $('summaryTable').innerHTML = ids.length ? ids.map(function (id) {
      var m = map[id];
      return '<tr><td class="strong">' + esc(m.name) + '</td><td>' + m.trips + '</td><td>' + m.done + '</td><td>' + m.canc +
        '</td><td>' + round2(m.km) + '</td><td class="strong">' + money(m.earn) + '</td></tr>';
    }).join('') : '<tr><td colspan="6" class="empty">No drivers yet.</td></tr>';

    // driver filter options (preserve selection)
    var sel = $('fDriver');
    var current = sel.value || 'all';
    sel.innerHTML = '<option value="all">All drivers</option>' + ids.map(function (id) {
      return '<option value="' + esc(id) + '">' + esc(map[id].name) + '</option>';
    }).join('');
    sel.value = ids.indexOf(current) >= 0 ? current : 'all';

    renderHistoryTable();
  }

  function filteredHistory() {
    var st = $('fStatus').value;
    var dr = $('fDriver').value;
    var q = $('fSearch').value.trim().toLowerCase();
    return history().filter(function (b) {
      if (st !== 'all' && b.status !== st) return false;
      if (dr !== 'all' && b.driverId !== dr) return false;
      if (q) {
        var hay = (b.customer + ' ' + b.pickup + ' ' + b.drop + ' ' + b.id).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function (a, b) { return (b.closedAt || 0) - (a.closedAt || 0); });
  }

  function renderHistoryTable() {
    var rows = filteredHistory();
    $('historyCount').textContent = rows.length;
    $('historyTable').innerHTML = rows.length ? rows.map(function (b) {
      return '<tr><td>' + esc(b.id) + '</td><td>' + fmtDate(b.closedAt) + '</td><td class="strong">' + esc(b.customer) + '</td>' +
        '<td class="route">' + esc(b.pickup) + '<small>to ' + esc(b.drop) + '</small></td>' +
        '<td>' + esc(b.driverName || '-') + '</td><td>' + (b.status === 'Completed' ? esc(b.fare.distance) : '-') + '</td>' +
        '<td class="strong">' + money(b.fare.total) + '</td><td>' + badge(b.status) + '</td></tr>';
    }).join('') : '<tr><td colspan="8" class="empty">No trips match these filters.</td></tr>';
  }

  ['fStatus', 'fDriver'].forEach(function (id) { $(id).addEventListener('change', renderHistoryTable); });
  $('fSearch').addEventListener('input', renderHistoryTable);

  /* ---------- CSV export ---------- */
  $('csvBtn').addEventListener('click', function () {
    var rows = filteredHistory();
    if (!rows.length) { toast('Nothing to export', true); return; }
    var head = ['Booking', 'Closed', 'Customer', 'Phone', 'Pickup', 'Drop', 'Driver', 'Vehicle', 'Category', 'Distance km', 'Base', 'Distance charge', 'Night', 'Waiting', 'Toll', 'GST', 'Total', 'Status'];
    var lines = [head.join(',')];
    rows.forEach(function (b) {
      var f = b.fare;
      var cells = [b.id, fmtDate(b.closedAt), b.customer, b.phone, b.pickup, b.drop, b.driverName || '', b.vehicleLabel || '', b.category,
        f.distance, f.base, f.distCharge, f.night, f.waiting, f.toll, f.gst, f.total, b.status];
      lines.push(cells.map(function (c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(','));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'rido-taxi-history.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 500);
  });

  /* ---------- Drivers ---------- */
  $('driverForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('dName').value.trim();
    var phone = $('dPhone').value.trim();
    var license = $('dLicense').value.trim().toUpperCase();
    var exp = parseInt($('dExp').value, 10);
    var err = $('dError');
    err.textContent = '';

    if (name.length < 2) { err.textContent = 'Please enter the driver\'s full name.'; return; }
    if (!/^[6-9]\d{9}$/.test(phone)) { err.textContent = 'Enter a valid 10-digit mobile number.'; return; }
    if (license.length < 6) { err.textContent = 'Enter a valid licence number.'; return; }
    if (isNaN(exp) || exp < 0) { err.textContent = 'Experience must be 0 or more years.'; return; }
    if (state.drivers.some(function (d) { return d.license === license; })) { err.textContent = 'A driver with this licence is already registered.'; return; }

    state.drivers.push({ id: nextId('d'), name: name, phone: phone, license: license, exp: exp, status: 'Available' });
    save(); renderAll();
    this.reset(); $('dExp').value = 1;
    toast('Driver registered');
  });

  function toggleDriver(id) {
    var d = findDriver(id);
    if (!d || d.status === 'On Trip') return;
    d.status = d.status === 'Offline' ? 'Available' : 'Offline';
    save(); renderAll();
  }
  function deleteDriver(id) {
    var d = findDriver(id);
    if (!d || d.status === 'On Trip') return;
    if (!confirm('Delete driver ' + d.name + '? Past trips will keep their record.')) return;
    state.drivers = state.drivers.filter(function (x) { return x.id !== id; });
    save(); renderAll();
    toast('Driver deleted');
  }

  /* ---------- Vehicles ---------- */
  function fillCategories() {
    var opts = Object.keys(RATES).map(function (k) { return '<option value="' + k + '">' + k + '</option>'; }).join('');
    $('vCategory').innerHTML = opts;
    $('bCategory').innerHTML = opts;
    $('vSeats').value = RATES[$('vCategory').value].seats;
  }
  $('vCategory').addEventListener('change', function () { $('vSeats').value = RATES[this.value].seats; });

  $('vehicleForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var reg = $('vReg').value.trim().toUpperCase().replace(/\s+/g, ' ');
    var model = $('vModel').value.trim();
    var category = $('vCategory').value;
    var seats = parseInt($('vSeats').value, 10);
    var err = $('vError');
    err.textContent = '';

    if (reg.length < 6) { err.textContent = 'Enter a valid registration number.'; return; }
    if (model.length < 2) { err.textContent = 'Enter the vehicle make and model.'; return; }
    if (isNaN(seats) || seats < 2) { err.textContent = 'Seats must be at least 2.'; return; }
    if (sta