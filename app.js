/* Membership LIFF app. No build step. All server strings are rendered via textContent (see h()). */
(function () {
  'use strict';

  var CFG = window.APP_CONFIG || {};
  var NO_RETRY = { register: 1, link: 1, redeemInvite: 1 }; // contract §3: never auto-retry; re-query instead
  var CACHE_KEY = 'cm_me_cache_v1';
  var SESSION_KEY = 'cm_session_v1';
  var GUARD_KEY = 'cm_idtoken_guard_v1';
  var PREFIXES = ['นาย', 'นาง', 'นางสาว', 'ภก.', 'ภญ.', 'อื่นๆ'];

  var ERR = {
    BAD_REQUEST: 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบแล้วลองอีกครั้ง',
    UNAUTHENTICATED: 'เซสชันหมดอายุ กรุณาลองใหม่อีกครั้ง',
    ID_TOKEN_INVALID: 'การเข้าสู่ระบบ LINE หมดอายุ กรุณาเปิดหน้านี้ใหม่อีกครั้ง',
    NOT_LINKED: 'บัญชี LINE นี้ยังไม่ได้เชื่อมต่อกับร้าน',
    ALREADY_LINKED: 'บัญชี LINE นี้เชื่อมต่อกับร้านแล้ว',
    RATE_LIMITED: 'ลองหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่ภายหลัง',
    NOT_OWNER: 'เฉพาะเจ้าของร้านเท่านั้นที่ทำรายการนี้ได้',
    STAFF_LIMIT: 'ร้านนี้มีพนักงานครบจำนวนสูงสุดแล้ว (3 คน)',
    INVITE_INVALID: 'ลิงก์เชิญไม่ถูกต้อง หมดอายุ หรือถูกใช้แล้ว กรุณาขอลิงก์ใหม่จากเจ้าของร้าน',
    MEMBERSHIP_EXPIRED: 'สมาชิกหมดอายุ กรุณาต่ออายุสมาชิกก่อนลงทะเบียน',
    SEMINAR_CLOSED: 'การลงทะเบียนสัมมนานี้ปิดแล้ว',
    SEATS_FULL: 'ที่นั่งเต็มแล้ว',
    STORE_LIMIT: 'ร้านนี้ลงทะเบียนครบ 2 ท่านแล้ว',
    ALREADY_CHECKED_IN: 'เช็คอินแล้ว ไม่สามารถยกเลิกได้',
    BUSY: 'ระบบกำลังทำงานหนัก กรุณาลองใหม่อีกครั้งในอีกสักครู่',
    INTERNAL: 'ระบบขัดข้อง กรุณาลองใหม่อีกครั้ง',
    NETWORK: 'เชื่อมต่อเครือข่ายไม่ได้ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่',
    TIMEOUT: 'ระบบตอบสนองช้า กรุณาลองใหม่อีกครั้ง'
  };

  // ---------- tiny DOM helper: text is always set via text nodes ----------
  function h(tag, props) {
    var e = document.createElement(tag);
    var k;
    props = props || {};
    for (k in props) {
      var v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (var i = 2; i < arguments.length; i++) add(e, arguments[i]);
    return e;
  }
  function add(e, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(e, x); }); return; }
    e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }

  // ---------- safe storage ----------
  function sget(store, key) { try { return JSON.parse(window[store].getItem(key)); } catch (e) { return null; } }
  function sset(store, key, val) { try { window[store].setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ } }
  function sdel(store, key) { try { window[store].removeItem(key); } catch (e) { /* ignore */ } }

  // ---------- normalization (mirrors contract §1) ----------
  function normalizePhone(raw) {
    var s = String(raw || '').replace(/\D/g, '');
    if (s.indexOf('66') === 0 && s.length === 11) s = '0' + s.slice(2);
    else if (s.length === 9 && '689'.indexOf(s.charAt(0)) >= 0) s = '0' + s;
    return s.length < 9 ? '' : s;
  }
  function normalizeLicense(raw) {
    var s = String(raw || '').replace(/\D/g, '').replace(/^0+/, '');
    return s;
  }

  // ---------- errors / API ----------
  function ApiError(code, message) {
    var e = new Error(message || ERR[code] || code);
    e.code = code;
    e.network = code === 'NETWORK' || code === 'TIMEOUT';
    return e;
  }
  function friendly(e) {
    var code = e && e.code;
    if (code && ERR[code]) return ERR[code];
    return (e && e.serverMessage) || ERR.INTERNAL;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function transport(body) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, 20000) : null;
    return fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined
    }).then(function (res) {
      return res.json();
    }).then(function (j) {
      if (timer) clearTimeout(timer);
      if (j && j.ok) return j.data || {};
      var err = ApiError((j && j.error) || 'INTERNAL');
      err.serverMessage = j && j.message;
      throw err;
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw ApiError(e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
    });
  }

  // retry (1 s, 3 s + jitter) only for network errors and BUSY, and never for NO_RETRY actions
  function transportRetry(body) {
    var delays = [1000, 3000];
    var attempt = 0;
    function go() {
      return transport(body).catch(function (e) {
        var retriable = !NO_RETRY[body.action] && (e.network || e.code === 'BUSY');
        if (retriable && attempt < delays.length) {
          var d = delays[attempt++] + Math.floor(Math.random() * 400);
          return sleep(d).then(go);
        }
        throw e;
      });
    }
    return go();
  }

  // ---------- LIFF / session ----------
  var S = { me: null, seminars: null, tab: 'card', page: 'card', code: '', sessionPromise: null };

  function endpointBase() {
    return location.origin + location.pathname.replace(/index\.html$/, '');
  }
  // Resolves to a shareable LIFF URL. createUrlBy() returns a Promise in the LIFF SDK.
  function liffUrlFor(page, code) {
    var q = '';
    if (page && page !== 'card') q = '?page=' + encodeURIComponent(page) + (code ? '&c=' + encodeURIComponent(code) : '');
    var fallback = 'https://liff.line.me/' + CFG.LIFF_ID + q;
    try {
      return Promise.resolve(liff.permanentLink.createUrlBy(endpointBase() + q))
        .then(function (u) { return typeof u === 'string' && u ? u : fallback; }, function () { return fallback; });
    } catch (e) { return Promise.resolve(fallback); }
  }

  function recoverIdToken() {
    if (sget('sessionStorage', GUARD_KEY)) throw ApiError('ID_TOKEN_INVALID'); // one shot only
    sset('sessionStorage', GUARD_KEY, 1);
    liffUrlFor(S.page, S.code).then(function (target) {
      try { liff.logout(); } catch (e) { /* ignore */ }
      location.replace(target);
    });
    return new Promise(function () { /* page is navigating away */ });
  }

  function newSession() {
    var tok = null;
    try { tok = liff.getIDToken(); } catch (e) { /* ignore */ }
    if (!tok) return recoverIdToken();
    return transport({ action: 'session', idToken: tok }).then(function (d) {
      sdel('sessionStorage', GUARD_KEY);
      sset('sessionStorage', SESSION_KEY, { token: d.session, exp: d.exp });
      return d;
    }, function (e) {
      if (e.code === 'ID_TOKEN_INVALID') return recoverIdToken();
      throw e;
    });
  }
  function getSession() {
    var s = sget('sessionStorage', SESSION_KEY);
    if (s && s.token && (!s.exp || s.exp * 1000 > Date.now() + 60000)) return Promise.resolve(s.token);
    if (!S.sessionPromise) {
      S.sessionPromise = newSession().then(function (d) { S.sessionPromise = null; return d.session; },
        function (e) { S.sessionPromise = null; throw e; });
    }
    return S.sessionPromise;
  }

  function call(action, params) {
    var reauthed = false;
    function once() {
      return getSession().then(function (tok) {
        var body = { action: action, session: tok };
        for (var k in (params || {})) body[k] = params[k];
        return transportRetry(body);
      }).catch(function (e) {
        if (e.code === 'UNAUTHENTICATED' && !reauthed) { // rejected before running: safe to redo once
          reauthed = true;
          sdel('sessionStorage', SESSION_KEY);
          return once();
        }
        throw e;
      });
    }
    return once();
  }

  // ---------- QR ----------
  function qrSvg(text, alnum) {
    if (typeof qrcode !== 'function' || !text) return null;
    var qr = qrcode(0, 'M');
    try { qr.addData(text, alnum ? 'Alphanumeric' : 'Byte'); } catch (e) { qr = qrcode(0, 'M'); qr.addData(text); }
    qr.make();
    var n = qr.getModuleCount(), q = 4, NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + (n + 2 * q) + ' ' + (n + 2 * q));
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR code');
    var bg = document.createElementNS(NS, 'rect');
    bg.setAttribute('width', n + 2 * q); bg.setAttribute('height', n + 2 * q); bg.setAttribute('fill', '#ffffff');
    svg.appendChild(bg);
    var d = '';
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) d += 'M' + (c + q) + ' ' + (r + q) + 'h1v1h-1z';
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d); p.setAttribute('fill', '#000000');
    svg.appendChild(p);
    return svg;
  }

  // ---------- UI primitives ----------
  var root = document.getElementById('app');

  function toast(msg) {
    var t = h('div', { class: 'toast', role: 'status', text: msg });
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2800);
  }

  function confirmDlg(title, msg, okText, danger) {
    return new Promise(function (resolve) {
      var prev = document.activeElement;
      function close(v) { ov.remove(); if (prev && prev.focus) prev.focus(); resolve(v); }
      var ok = h('button', { class: 'btn ' + (danger ? 'danger' : ''), type: 'button', text: okText || 'ตกลง', onclick: function () { close(true); } });
      var ov = h('div', { class: 'overlay', onclick: function (e) { if (e.target === ov) close(false); } },
        h('div', { class: 'dlg', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
          h('h3', { text: title }), h('p', { text: msg }),
          ok,
          h('button', { class: 'btn secondary', type: 'button', text: 'ยกเลิก', onclick: function () { close(false); } })));
      ov.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(false); });
      document.body.appendChild(ov);
      ok.focus();
    });
  }

  function busy(btn, label, fn) {
    var old = btn.textContent;
    btn.disabled = true; btn.textContent = label || 'กำลังดำเนินการ...';
    return Promise.resolve().then(fn).then(function (r) { btn.disabled = false; btn.textContent = old; return r; },
      function (e) { btn.disabled = false; btn.textContent = old; throw e; });
  }

  function shell(content, opts) {
    opts = opts || {};
    var me = S.me;
    var title = (me && me.state === 'linked' && me.card) ? me.card.store : 'บัตรสมาชิก';
    var initial = (me && me.displayName) ? Array.from(me.displayName)[0] : '★';
    var main = h('main', { class: opts.tabs ? 'has-tabs' : '' }, content);
    var kids = [
      h('header', { class: 'top' }, h('div', { class: 'av', 'aria-hidden': 'true', text: initial }),
        h('div', { class: 'grow' },
          h('div', { class: 't1', text: (me && me.displayName) ? 'สวัสดี ' + me.displayName : 'สมาคม / ระบบสมาชิก' }),
          h('div', { class: 't2', text: opts.tabs ? title : (opts.title || 'บัตรสมาชิก') }))),
      main
    ];
    if (opts.tabs) {
      kids.push(h('nav', { class: 'tabs', 'aria-label': 'เมนู' },
        tabBtn('card', 'บัตรสมาชิก'), tabBtn('seminar', 'สัมมนา')));
    }
    root.replaceChildren.apply(root, kids);
    window.scrollTo(0, 0);
  }
  function tabBtn(id, label) {
    return h('button', {
      class: 'tab', type: 'button', text: label, 'aria-current': S.tab === id ? 'page' : null,
      onclick: function () { S.tab = id; id === 'card' ? showCard() : showSeminars(); }
    });
  }

  function skeleton() {
    function sk(w, hgt) { return h('div', { class: 'sk', style: 'height:' + hgt + 'px;width:' + w + ';margin:10px 0' }); }
    shell(h('div', { class: 'card', 'aria-busy': 'true', 'aria-label': 'กำลังโหลด' },
      sk('60%', 26), sk('40%', 18), sk('100%', 44), sk('70%', 240), sk('50%', 20)));
  }

  function showError(e, retry) {
    var msg = friendly(e);
    var kids = [h('div', { class: 'card center' }, h('h2', { text: 'เกิดข้อผิดพลาด' }), h('p', { text: msg }),
      retry ? h('button', { class: 'btn', type: 'button', text: 'ลองอีกครั้ง', onclick: retry }) : null)];
    if (e && e.code === 'ID_TOKEN_INVALID') {
      kids[0].appendChild(h('button', {
        class: 'btn secondary', type: 'button', text: 'เปิดใหม่อีกครั้ง',
        onclick: function () { sdel('sessionStorage', GUARD_KEY); recoverIdToken(); }
      }));
    }
    shell(kids);
  }

  // ---------- data loading ----------
  function loadMe() {
    return call('me').then(function (me) {
      S.me = me;
      if (me.state === 'linked' && me.card) sset('localStorage', CACHE_KEY, { displayName: me.displayName, card: me.card, ts: Date.now() });
      else sdel('localStorage', CACHE_KEY);
      return me;
    });
  }

  function route() {
    var me = S.me;
    if (S.page === 'invite') return showInvite();
    if (me.state === 'unlinked') return showLinkForm();
    if (me.state === 'pending') return showPending();
    S.tab = S.page === 'seminar' ? 'seminar' : 'card';
    S.page = S.tab; // later reloads follow the tab
    return S.tab === 'seminar' ? showSeminars() : showCard();
  }

  // ---------- PDPA notice ----------
  function noticeBlock(idPrefix) {
    return h('div', null,
      h('p', { class: 'notice-sum', text: 'เราเก็บชื่อร้าน เลขสมาชิก เบอร์โทร เลขใบอนุญาต และชื่อบัญชี LINE เพื่อยืนยันตัวตนสมาชิก ออกบัตรสมาชิก และจัดการลงทะเบียนสัมมนา ข้อมูลเข้าถึงได้เฉพาะผู้ดูแลระบบ และจะไม่เปิดเผยแก่บุคคลภายนอก' }),
      h('details', null, h('summary', { text: 'อ่านนโยบายความเป็นส่วนตัวฉบับเต็ม' }),
        h('div', { id: idPrefix + '-full', text: '[ข้อความนโยบายความเป็นส่วนตัวฉบับเต็ม — เวอร์ชัน ' + (CFG.NOTICE_VERSION || '') + ' — ผู้ดูแลระบบจะเพิ่มข้อความจริงที่นี่]' })));
  }
  function acceptRow(idPrefix) {
    var cb = h('input', { type: 'checkbox', id: idPrefix + '-accept' });
    return { cb: cb, row: h('label', { class: 'check', for: idPrefix + '-accept' }, cb, h('span', { text: 'ข้าพเจ้ารับทราบนโยบายความเป็นส่วนตัว' })) };
  }
  function field(id, label, attrs, required, hint) {
    var inp = h('input', Object.assign({ type: 'text', id: id, autocomplete: 'off' }, attrs || {}));
    return { input: inp, node: h('div', null, h('label', { for: id }, label, required ? h('span', { class: 'req', text: ' *' }) : null), inp, hint ? h('div', { class: 'muted', text: hint }) : null) };
  }
  function errBox() { return h('div', { class: 'banner err', role: 'alert', style: 'display:none;margin-top:12px' }); }
  function showErr(box, msg) { box.textContent = msg; box.style.display = msg ? 'block' : 'none'; }

  // ---------- screens ----------
  function showLinkForm() {
    var fId = field('f-id', 'เลขที่สมาชิก', { inputmode: 'text', maxlength: 20 }, true);
    var fPh = field('f-ph', 'เบอร์โทรศัพท์ที่ลงทะเบียนไว้', { type: 'tel', inputmode: 'tel', maxlength: 20 }, true);
    var fLic = field('f-lic', 'เลขที่ใบอนุญาตประกอบวิชาชีพเภสัชกรรม', { inputmode: 'text', maxlength: 20 }, true);
    var fSt = field('f-st', 'ชื่อร้าน (ถ้ามี)', { maxlength: 100 }, false);
    var note = h('textarea', { id: 'f-note', maxlength: 300 });
    var acc = acceptRow('link');
    var box = errBox();
    var btn = h('button', { class: 'btn', type: 'button', text: 'เชื่อมต่อบัญชี' });
    btn.addEventListener('click', function () {
      var memberId = fId.input.value.trim(), phone = fPh.input.value.trim(), lic = fLic.input.value.trim();
      if (!memberId) return showErr(box, 'กรุณากรอกเลขที่สมาชิก');
      if (!normalizePhone(phone)) return showErr(box, 'กรุณากรอกเบอร์โทรศัพท์ให้ถูกต้อง');
      if (!normalizeLicense(lic)) return showErr(box, 'กรุณากรอกเลขที่ใบอนุญาต');
      if (!acc.cb.checked) return showErr(box, 'กรุณาติ๊กรับทราบนโยบายความเป็นส่วนตัว');
      showErr(box, '');
      busy(btn, 'กำลังตรวจสอบ...', function () {
        return call('link', { memberId: memberId, phone: phone, license: lic, store: fSt.input.value.trim(), note: note.value.trim(), accept: true })
          .then(function () { return loadMe(); })
          .then(function () { toast('ส่งข้อมูลแล้ว'); route(); });
      }).catch(function (e) {
        if (e.network) { // outcome unknown: re-query instead of retrying
          return loadMe().then(function (me) {
            if (me.state !== 'unlinked') route();
            else showErr(box, 'ไม่แน่ใจว่าส่งข้อมูลสำเร็จหรือไม่ — ยังไม่พบคำขอของคุณ กรุณากดส่งอีกครั้ง');
          }, function (e2) { showErr(box, friendly(e2)); });
        }
        if (e.code === 'ALREADY_LINKED') return loadMe().then(route, function () { showErr(box, friendly(e)); });
        showErr(box, friendly(e));
      });
    });
    shell([
      h('div', { class: 'card' },
        h('h2', { text: 'เชื่อมต่อบัญชีกับร้านสมาชิก' }),
        h('p', { class: 'muted', text: 'กรอกข้อมูลให้ตรงกับที่ลงทะเบียนไว้กับสมาคม เพื่อเปิดบัตรสมาชิกในบัญชี LINE นี้' }),
        fId.node, fPh.node, fLic.node, fSt.node,
        h('label', { for: 'f-note', text: 'หมายเหตุถึงผู้ดูแล (ถ้ามี)' }), note,
        noticeBlock('link'), acc.row, box, btn)
    ]);
  }

  function showPending() {
    var p = S.me.pending || {};
    var box = errBox();
    var btn = h('button', { class: 'btn secondary', type: 'button', text: 'ยกเลิกคำขอ' });
    btn.addEventListener('click', function () {
      confirmDlg('ยกเลิกคำขอ', 'ต้องการยกเลิกคำขอเชื่อมต่อนี้หรือไม่?', 'ยกเลิกคำขอ', true).then(function (ok) {
        if (!ok) return;
        busy(btn, 'กำลังยกเลิก...', function () { return call('cancelPending').then(loadMe).then(route); })
          .catch(function (e) { showErr(box, friendly(e)); });
      });
    });
    shell(h('div', { class: 'card center' },
      h('h2', { text: 'ส่งคำขอให้ผู้ดูแลตรวจสอบแล้ว' }),
      h('p', { text: 'ผู้ดูแลจะตรวจสอบและอนุมัติโดยเร็ว เมื่ออนุมัติแล้วให้เปิดหน้านี้อีกครั้งเพื่อดูบัตรสมาชิก' }),
      p.memberId ? h('p', { class: 'muted', text: 'เลขที่สมาชิกที่ส่ง: ' + p.memberId + (p.createdAt ? ' • ' + fmtDate(p.createdAt) : '') }) : null,
      h('button', { class: 'btn', type: 'button', text: 'ตรวจสอบสถานะ', onclick: function (ev) { busy(ev.currentTarget, 'กำลังตรวจสอบ...', function () { return loadMe().then(route); }).catch(function (e) { showErr(box, friendly(e)); }); } }),
      btn, box));
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString('th-TH-u-ca-buddhist', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }); } catch (e) { return String(iso || ''); }
  }

  function cardNode(card, stale) {
    var qr = card.qr ? qrSvg(card.qr, true) : null;
    return h('div', { class: 'card' },
      h('div', { class: 'row wrap' },
        h('span', { class: 'badge role', text: card.role === 'owner' ? 'เจ้าของร้าน' : 'พนักงาน' }),
        stale ? h('span', { class: 'muted', text: 'กำลังอัปเดต...' }) : null),
      h('div', { class: 'store', text: card.store }),
      card.district ? h('div', { class: 'muted', text: 'อำเภอ ' + card.district }) : null,
      h('div', { class: 'status ' + (card.active ? 'ok' : 'bad'), text: card.active ? 'ใช้งานได้ ถึง ' + card.validUntilText : 'หมดอายุ — กรุณาต่ออายุสมาชิก' }),
      card.renewalDue ? h('div', { class: 'banner', text: 'ใกล้ถึงเวลาต่ออายุสมาชิกปี ' + (card.paidThroughYearBE + 1) + ' กรุณาติดต่อผู้ดูแลเพื่อต่ออายุ' }) : null,
      h('div', { class: 'qrwrap' },
        qr ? h('div', { class: 'qrbox' }, qr) : h('div', { class: 'banner', text: 'ยังไม่มี QR — แจ้งเลขที่สมาชิกกับเจ้าหน้าที่หน้างาน' }),
        h('div', { class: 'qrid', text: 'เลขที่สมาชิก ' + card.memberId }),
        qr ? h('div', { class: 'hint', text: 'เพิ่มความสว่างหน้าจอเมื่อสแกน' }) : null));
  }

  function showCachedCard() {
    var c = sget('localStorage', CACHE_KEY);
    if (!c || !c.card || !c.card.memberId) return false;
    S.me = { state: 'linked', displayName: c.displayName, card: c.card };
    S.tab = 'card';
    shell(cardNode(c.card, true), { tabs: false });
    return true;
  }

  function showCard() {
    var me = S.me, card = me.card;
    if (!card) return showLinkForm();
    var nodes = [cardNode(card, false)];
    if (card.role === 'owner') nodes.push(ownerSection(me));
    var box = errBox();
    var unlink = h('button', { class: 'btn ghost', type: 'button', text: 'ยกเลิกการเชื่อมต่อบัญชีนี้' });
    unlink.addEventListener('click', function () {
      var owner = card.role === 'owner';
      confirmDlg('ยกเลิกการเชื่อมต่อ', owner ? 'คุณเป็นเจ้าของร้าน หากยกเลิก ร้านจะไม่มีเจ้าของจนกว่าจะมีการเชื่อมต่อใหม่หรือผู้ดูแลกำหนดให้ ต้องการดำเนินการต่อหรือไม่?' : 'ต้องการยกเลิกการเชื่อมต่อบัญชี LINE นี้กับร้านหรือไม่?', 'ยกเลิกการเชื่อมต่อ', true).then(function (ok) {
        if (!ok) return;
        busy(unlink, 'กำลังดำเนินการ...', function () { return call('unlinkSelf').then(function () { sdel('localStorage', CACHE_KEY); S.seminars = null; S.page = 'card'; return loadMe(); }).then(route); })
          .catch(function (e) { showErr(box, friendly(e)); });
      });
    });
    nodes.push(h('div', { class: 'card' }, unlink, box));
    shell(nodes, { tabs: true });
  }

  function ownerSection(me) {
    var staff = me.staff || [];
    var box = errBox();
    var list = staff.length ? staff.map(function (s) {
      var rm = h('button', { class: 'btn ghost sm', type: 'button', text: 'ลบ', 'aria-label': 'ลบพนักงาน ' + s.displayName });
      rm.addEventListener('click', function () {
        confirmDlg('ลบพนักงาน', 'ต้องการลบ "' + s.displayName + '" ออกจากร้านหรือไม่?', 'ลบ', true).then(function (ok) {
          if (!ok) return;
          busy(rm, '...', function () { return call('removeStaff', { linkId: s.linkId }).then(loadMe).then(function () { toast('ลบพนักงานแล้ว'); showCard(); }); })
            .catch(function (e) { showErr(box, friendly(e)); });
        });
      });
      return h('div', { class: 'list-item' },
        h('div', { class: 'grow' }, h('div', { class: 'nm', text: s.displayName || '(ไม่ระบุชื่อ)' }), s.linkedAt ? h('div', { class: 'muted', text: 'เชื่อมต่อเมื่อ ' + fmtDate(s.linkedAt) }) : null), rm);
    }) : [h('p', { class: 'muted', text: 'ยังไม่มีพนักงานที่เชื่อมต่อ' })];
    var inv = h('button', { class: 'btn', type: 'button', text: 'เชิญพนักงาน' });
    inv.addEventListener('click', function () {
      busy(inv, 'กำลังสร้างลิงก์...', function () { return call('createInvite'); })
        .then(function (d) { showInviteCreated(d); })
        .catch(function (e) { showErr(box, friendly(e)); });
    });
    return h('div', { class: 'card' }, h('h3', { text: 'พนักงานของร้าน (' + staff.length + '/3)' }), list, inv, box);
  }

  function showInviteCreated(d) {
    shell([h('div', { class: 'card center' }, h('p', { class: 'muted', text: 'กำลังสร้างลิงก์...' }))], { tabs: false });
    liffUrlFor('invite', d.code).then(function (url) { renderInviteCreated(d, url); });
  }
  function renderInviteCreated(d, url) {
    var box = errBox();
    var kids = [h('div', { class: 'card center' },
      h('h2', { text: 'ลิงก์เชิญพนักงาน' }),
      h('p', { class: 'muted', text: 'ใช้ได้ครั้งเดียว หมดอายุ ' + fmtDate(d.expiresAt) }),
      h('div', { class: 'qrwrap' }, h('div', { class: 'qrbox sm' }, qrSvg(url, false) || document.createTextNode(''))),
      h('div', { class: 'invite-url', text: url }),
      box)];
    var card = kids[0];
    var canShare = false;
    try { canShare = liff.isApiAvailable && liff.isApiAvailable('shareTargetPicker'); } catch (e) { /* ignore */ }
    if (canShare) {
      var sb = h('button', { class: 'btn', type: 'button', text: 'ส่งลิงก์ผ่าน LINE' });
      sb.addEventListener('click', function () {
        busy(sb, 'กำลังเปิด...', function () {
          return liff.shareTargetPicker([{ type: 'text', text: 'เชิญเป็นพนักงานร้าน ' + (S.me.card.store) + '\nเปิดลิงก์เพื่อเชื่อมต่อบัญชี: ' + url }]);
        }).then(function (r) { if (r) toast('ส่งลิงก์แล้ว'); }).catch(function () { showErr(box, 'ไม่สามารถเปิดหน้าส่งลิงก์ได้ ลองคัดลอกลิงก์แทน'); });
      });
      card.appendChild(sb);
    }
    card.appendChild(h('button', { class: canShare ? 'btn secondary' : 'btn', type: 'button', text: 'คัดลอกลิงก์', onclick: function () { copyText(url).then(function (ok) { toast(ok ? 'คัดลอกลิงก์แล้ว' : 'คัดลอกไม่สำเร็จ กรุณาคัดลอกจากข้อความด้านบน'); }); } }));
    card.appendChild(h('button', { class: 'btn secondary', type: 'button', text: 'กลับ', onclick: function () { loadMe().then(showCard, function () { showCard(); }); } }));
    shell(kids, { tabs: false });
  }

  function copyText(t) {
    function legacy() {
      try {
        var ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = t; document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy'); ta.remove(); return ok;
      } catch (e) { return false; }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).then(function () { return true; }, function () { return legacy(); });
    return Promise.resolve(legacy());
  }

  function showInvite() {
    var me = S.me, code = S.code;
    if (me.state === 'linked') {
      return shell(h('div', { class: 'card center' }, h('h2', { text: 'บัญชีนี้เชื่อมต่อกับร้านแล้ว' }),
        h('p', { text: 'หากต้องการเข้าร่วมร้านอื่น กรุณายกเลิกการเชื่อมต่อปัจจุบันก่อน' }),
        h('button', { class: 'btn', type: 'button', text: 'ไปที่บัตรสมาชิก', onclick: function () { S.page = 'card'; route(); } })));
    }
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(code || '')) {
      return shell(h('div', { class: 'card center' }, h('h2', { text: 'ลิงก์เชิญไม่ถูกต้อง' }), h('p', { text: ERR.INVITE_INVALID })));
    }
    var acc = acceptRow('inv');
    var box = errBox();
    var btn = h('button', { class: 'btn', type: 'button', text: 'ยอมรับและเชื่อมต่อ' });
    btn.addEventListener('click', function () {
      if (!acc.cb.checked) return showErr(box, 'กรุณาติ๊กรับทราบนโยบายความเป็นส่วนตัว');
      showErr(box, '');
      busy(btn, 'กำลังเชื่อมต่อ...', function () {
        return call('redeemInvite', { code: code, accept: true }).then(loadMe).then(function () { toast('เชื่อมต่อสำเร็จ'); S.page = 'card'; route(); });
      }).catch(function (e) {
        if (e.network) {
          return loadMe().then(function (m) {
            if (m.state === 'linked') { S.page = 'card'; route(); } else showErr(box, 'ไม่แน่ใจว่าเชื่อมต่อสำเร็จหรือไม่ กรุณากดอีกครั้ง');
          }, function (e2) { showErr(box, friendly(e2)); });
        }
        showErr(box, friendly(e));
      });
    });
    shell(h('div', { class: 'card' }, h('h2', { text: 'คำเชิญเป็นพนักงานร้าน' }),
      h('p', { text: 'คุณได้รับเชิญให้เชื่อมต่อบัญชี LINE นี้กับร้านสมาชิกในฐานะพนักงาน เพื่อใช้บัตรสมาชิกและลงทะเบียนสัมมนา' }),
      noticeBlock('inv'), acc.row, box, btn));
  }

  // ---------- seminars ----------
  function showSeminars() {
    S.tab = 'seminar';
    shell(h('div', { class: 'card', 'aria-busy': 'true' }, h('div', { class: 'sk', style: 'height:26px;width:60%;margin:8px 0' }), h('div', { class: 'sk', style: 'height:90px;margin:8px 0' })), { tabs: true });
    call('seminars').then(function (d) { S.seminars = d.seminars || []; renderSeminars(); },
      function (e) { shell([h('div', { class: 'card center' }, h('p', { text: friendly(e) }), h('button', { class: 'btn', type: 'button', text: 'ลองอีกครั้ง', onclick: showSeminars }))], { tabs: true }); });
  }

  function liveAttendees(sem) {
    return ((sem.registration && sem.registration.attendees) || []).filter(function (a) { return a && String(a.name || '').trim(); });
  }

  function renderSeminars() {
    var card = S.me && S.me.card;
    var active = !!(card && card.active);
    var nodes = [];
    if (!active) nodes.push(h('div', { class: 'banner err', text: 'สมาชิกหมดอายุ — ดูรายการสัมมนาได้ แต่ต้องต่ออายุสมาชิกก่อนจึงจะลงทะเบียนได้' }));
    if (!S.seminars.length) nodes.push(h('div', { class: 'card center' }, h('p', { class: 'muted', text: 'ยังไม่มีสัมมนาที่เปิดรับลงทะเบียน' })));
    S.seminars.forEach(function (sem) { nodes.push(seminarCard(sem, active)); });
    shell(nodes, { tabs: true });
  }

  function seminarCard(sem, active) {
    var atts = liveAttendees(sem);
    var remaining = 2 - atts.length;
    var full = sem.seatsLeft === 0;
    var box = errBox();
    var c = h('div', { class: 'card' },
      h('div', { class: 'sem-title', text: sem.title }),
      h('div', { class: 'muted', text: [sem.dateText, sem.venue].filter(Boolean).join(' • ') }),
      h('div', { class: 'row wrap', style: 'margin-top:8px' },
        h('span', { class: 'badge ' + (sem.open ? 'ok' : 'bad'), text: sem.open ? 'เปิดรับลงทะเบียน' : 'ปิดรับลงทะเบียน' }),
        sem.seatsLeft != null ? h('span', { class: 'muted', text: full ? 'ที่นั่งเต็ม' : 'เหลือ ' + sem.seatsLeft + ' ที่นั่ง' }) : null));
    if (atts.length) {
      c.appendChild(h('h3', { style: 'margin-top:14px', text: 'ผู้ลงทะเบียนของร้านคุณ' }));
      atts.forEach(function (a) {
        var cancellable = a.canCancel != null ? !!a.canCancel : (!a.checkedIn && (!a.channel || a.channel === 'LINE'));
        var row = h('div', { class: 'att' + (a.checkedIn ? ' done' : '') },
          h('div', { class: 'row' },
            h('div', { class: 'grow' },
              h('div', { class: 'nm', style: 'font-weight:700;overflow-wrap:anywhere', text: ((a.prefix || '') + ' ' + a.name).trim() }),
              h('div', { class: 'sub', text: [a.phone, a.license ? 'ใบอนุญาต ' + a.license : ''].filter(Boolean).join(' • ') }),
              a.checkedIn ? h('div', { class: 'sub', text: 'เช็คอินแล้ว' }) : null)));
        if (cancellable) {
          var cb = h('button', { class: 'btn ghost sm', type: 'button', text: 'ยกเลิก', 'aria-label': 'ยกเลิกการลงทะเบียน ' + a.name });
          cb.addEventListener('click', function () {
            confirmDlg('ยกเลิกการลงทะเบียน', 'ยกเลิกการลงทะเบียนของ "' + a.name + '" ใช่หรือไม่?', 'ยกเลิกการลงทะเบียน', true).then(function (ok) {
              if (!ok) return;
              busy(cb, '...', function () { return call('cancelRegistration', { seminarId: sem.seminarId, row: a.row, slot: a.slot }).then(function () { toast('ยกเลิกแล้ว'); showSeminars(); }); })
                .catch(function (e) { showErr(box, friendly(e)); });
            });
          });
          row.firstChild.appendChild(cb);
        }
        c.appendChild(row);
      });
    }
    c.appendChild(box);
    if (!sem.open) return c;
    if (!active) { c.appendChild(h('div', { class: 'banner err', style: 'margin-top:10px', text: 'กรุณาต่ออายุสมาชิกก่อนลงทะเบียน' })); return c; }
    if (remaining <= 0) { c.appendChild(h('p', { class: 'muted', style: 'margin-top:8px', text: 'ร้านนี้ลงทะเบียนครบ 2 ท่านแล้ว' })); return c; }
    if (full) return c;
    var maxN = sem.seatsLeft != null ? Math.min(remaining, sem.seatsLeft) : remaining;
    var formHost = h('div');
    var open = h('button', { class: 'btn', type: 'button', text: atts.length ? 'เพิ่มผู้เข้าร่วม' : 'ลงทะเบียน' });
    open.addEventListener('click', function () { open.remove(); formHost.appendChild(registerForm(sem, maxN, atts.length === 0)); });
    c.appendChild(open); c.appendChild(formHost);
    return c;
  }

  function lastKnownAttendee() {
    var found = null;
    (S.seminars || []).forEach(function (s) { var a = liveAttendees(s); if (a.length && !found) found = a[0]; });
    return found;
  }

  function attendeeFields(i, pre) {
    var sel = h('select', { id: 'a' + i + '-px', 'aria-label': 'คำนำหน้า' }, PREFIXES.map(function (p) { return h('option', { value: p, text: p }); }));
    if (pre && PREFIXES.indexOf(pre.prefix) >= 0) sel.value = pre.prefix;
    var nm = h('input', { type: 'text', id: 'a' + i + '-nm', autocomplete: 'name', maxlength: 100, value: pre ? pre.name : null });
    var lic = h('input', { type: 'text', id: 'a' + i + '-lic', inputmode: 'text', maxlength: 20, value: pre ? pre.license : null });
    var ph = h('input', { type: 'tel', id: 'a' + i + '-ph', inputmode: 'tel', maxlength: 20, value: pre ? pre.phone : null });
    var err = h('div', { class: 'field-err', role: 'alert' });
    var node = h('div', { class: 'att' }, h('h3', { text: 'ผู้เข้าร่วมท่านที่ ' + (i + 1) }),
      h('div', { class: 'fgrid' },
        h('div', null, h('label', { for: 'a' + i + '-px', text: 'คำนำหน้า' }), sel),
        h('div', null, h('label', { for: 'a' + i + '-nm' }, 'ชื่อ - นามสกุล', h('span', { class: 'req', text: ' *' })), nm)),
      h('label', { for: 'a' + i + '-lic', text: 'เลขที่ใบอนุญาต (ถ้ามี)' }), lic,
      h('label', { for: 'a' + i + '-ph' }, 'เบอร์โทรศัพท์', h('span', { class: 'req', text: ' *' })), ph, err);
    function get() {
      var e = '';
      var name = nm.value.trim().replace(/\s+/g, ' ');
      var phone = normalizePhone(ph.value);
      var license = normalizeLicense(lic.value);
      if (!name) e = 'กรุณากรอกชื่อ - นามสกุล';
      else if (!/^0\d{8,9}$/.test(phone)) e = 'เบอร์โทรศัพท์ไม่ถูกต้อง (เช่น 0812345678)';
      else if (license && !/^[1-9]\d{0,5}$/.test(license)) e = 'เลขที่ใบอนุญาตไม่ถูกต้อง (ตัวเลข 1–6 หลัก)';
      err.textContent = e;
      return e ? null : { prefix: sel.value, name: name, license: license, phone: phone };
    }
    return { node: node, get: get };
  }

  function registerForm(sem, maxN, prefill) {
    var count = 1;
    var pre = prefill ? lastKnownAttendee() : null;
    var fields = [attendeeFields(0, pre), attendeeFields(1, null)];
    var host = h('div', { style: 'margin-top:12px' });
    var box = errBox();
    var submit = h('button', { class: 'btn', type: 'button', text: 'ยืนยันการลงทะเบียน' });
    var segHost = h('div');
    function draw() {
      segHost.replaceChildren();
      if (maxN > 1) {
        segHost.appendChild(h('div', { class: 'muted', text: 'จำนวนผู้เข้าร่วม' }));
        segHost.appendChild(h('div', { class: 'seg' }, [1, 2].map(function (n) {
          return h('button', { type: 'button', text: n + ' ท่าน', 'aria-pressed': count === n ? 'true' : 'false', onclick: function () { count = n; draw(); } });
        })));
      }
      host.replaceChildren(segHost);
      for (var i = 0; i < count; i++) host.appendChild(fields[i].node);
      host.appendChild(box); host.appendChild(submit);
    }
    submit.addEventListener('click', function () {
      var atts = [];
      var before = liveAttendees(sem).length;
      for (var i = 0; i < count; i++) { var v = fields[i].get(); if (!v) { showErr(box, 'กรุณาตรวจสอบข้อมูลผู้เข้าร่วม'); return; } atts.push(v); }
      showErr(box, '');
      busy(submit, 'กำลังลงทะเบียน...', function () {
        return call('register', { seminarId: sem.seminarId, attendees: atts }).then(function () { toast('ลงทะเบียนสำเร็จ'); showSeminars(); });
      }).catch(function (e) {
        if (e.network) { // never retry: re-query to see whether it went through
          return call('seminars').then(function (d) {
            S.seminars = d.seminars || [];
            var s = S.seminars.filter(function (x) { return x.seminarId === sem.seminarId; })[0];
            if (s && liveAttendees(s).length >= before + atts.length) { toast('ลงทะเบียนสำเร็จ'); renderSeminars(); }
            else showErr(box, 'ยังไม่พบการลงทะเบียน กรุณากดยืนยันอีกครั้ง');
          }, function (e2) { showErr(box, friendly(e2)); });
        }
        if (e.code === 'MEMBERSHIP_EXPIRED') { loadMe().then(function () { showSeminars(); }, function () { /* keep form */ }); }
        showErr(box, friendly(e));
      });
    });
    draw();
    return host;
  }

  // ---------- boot ----------
  function boot() {
    var preCached = false;
    if (!/liff\.state|[?&]c=|invite/.test(location.search + location.hash)) preCached = showCachedCard();
    if (!preCached) skeleton();
    if (typeof liff === 'undefined') return showError(ApiError('NETWORK'), function () { location.reload(); });
    liff.init({ liffId: CFG.LIFF_ID, withLoginOnExternalBrowser: true }).then(function () {
      if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return new Promise(function () { }); }
      // routing is read only after init resolves
      var q = new URLSearchParams(location.search);
      var pg = q.get('page');
      S.page = (pg === 'seminar' || pg === 'invite') ? pg : 'card';
      S.code = q.get('c') || '';
      if (!preCached || S.page === 'invite') skeleton();
      return loadMe().then(route);
    }).catch(function (e) {
      if (!e || !e.code) e = ApiError('NETWORK');
      showError(e, function () { location.reload(); });
    });
  }

  boot();
})();
