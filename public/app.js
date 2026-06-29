// public/app.js — ตรรกะหน้าบ้าน (SPA)
const $ = (s, r = document) => r.querySelector(s);
const el = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstChild; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const RANK = { intern: 0, angel: 1, guardian: 2, god: 3 };
const TYPE_TH = { import: 'นำเข้า', withdraw: 'เบิกออก', move: 'ย้ายช่อง', initial: 'นับตั้งต้น' };
const STATUS_TH = { pending: 'รออนุมัติ', confirmed: 'ยืนยันแล้ว', cancelled: 'ยกเลิก' };

let ME = null, CELLS = [];

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
  return data;
}
function toast(msg, kind = 'ok') {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast show ' + kind;
  setTimeout(() => t.className = 'toast', 2200);
}
function can(role) { return RANK[ME.role] >= RANK[role]; }

// ---------- LOGIN ----------
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginErr').textContent = '';
  try {
    ME = await api('/login', { method: 'POST', body: { username: $('#li-user').value, password: $('#li-pass').value } });
    await boot();
  } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logoutBtn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }); location.reload();
});

// ---------- REGISTER (สมัครสมาชิก) ----------
$('#showRegister').addEventListener('click', () => {
  $('#loginView').classList.add('hidden'); $('#registerView').classList.remove('hidden');
});
$('#showLogin').addEventListener('click', () => {
  $('#registerView').classList.add('hidden'); $('#loginView').classList.remove('hidden');
});
$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#registerErr').textContent = '';
  try {
    const r = await api('/register', { method: 'POST', body: {
      full_name: $('#rg-name').value, username: $('#rg-user').value, password: $('#rg-pass').value } });
    $('#registerForm').reset();
    $('#showLogin').click();
    toast(r.message || 'ส่งคำขอสมัครแล้ว รออนุมัติ');
  } catch (err) { $('#registerErr').textContent = err.message; }
});

async function boot() {
  CELLS = await api('/cells');
  $('#loginView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  $('#whoName').textContent = ME.full_name;
  $('#whoRole').textContent = ME.role_th;
  buildNav();
  go('dashboard');
}

// ---------- NAV ----------
const VIEWS = [
  { key: 'dashboard', label: 'สต็อกปัจจุบัน', min: 'intern' },
  { key: 'movement', label: 'สร้างรายการ', min: 'angel' },
  { key: 'pending', label: 'รออนุมัติ', min: 'angel' },
  { key: 'reports', label: 'รายงานย้อนหลัง', min: 'guardian' },
  { key: 'products', label: 'สินค้า', min: 'guardian' },
  { key: 'admin', label: 'จัดการผู้ใช้', min: 'god' },
];
function closeNav() {
  $('#nav').classList.remove('open');
  $('#navBackdrop').classList.remove('show');
}
function buildNav() {
  const nav = $('#nav'); nav.innerHTML = '';
  VIEWS.filter(v => can(v.min)).forEach(v => {
    const a = el(`<div class="nav-item" data-k="${v.key}">${v.label}</div>`);
    a.onclick = () => { go(v.key); closeNav(); };
    nav.appendChild(a);
  });
}
$('#navToggle').addEventListener('click', () => {
  $('#nav').classList.toggle('open');
  $('#navBackdrop').classList.toggle('show');
});
$('#navBackdrop').addEventListener('click', closeNav);
function go(key) {
  const v = VIEWS.find(x => x.key === key);
  if (!v || !can(v.min)) key = 'dashboard';
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.k === key));
  ({ dashboard: viewDashboard, movement: viewMovement, pending: viewPending,
     reports: viewReports, products: viewProducts, admin: viewAdmin }[key])();
}

// ---------- DASHBOARD (สต็อกปัจจุบัน) ----------
async function viewDashboard() {
  const c = $('#content');
  c.innerHTML = `<div class="panel">
    <h2>สต็อกปัจจุบัน</h2>
    <p class="desc">ของแต่ละชนิดอยู่ช่องไหน เหลือเท่าไหร่ (รวมทุกช่อง)</p>
    <div class="row">
      <div style="display:flex;gap:8px">
        <input id="stockQ" placeholder="ค้นหาด้วยรหัส/บาร์โค้ด หรือชื่อสินค้า" style="flex:1">
        <button type="button" class="btn btn-sky btn-sm" id="stockScanBtn" title="สแกนบาร์โค้ด">📷 สแกน</button>
      </div>
    </div>
    <div id="stockBody" style="margin-top:16px"></div>
  </div>`;
  $('#stockScanBtn').onclick = () => openScanner((code) => {
    $('#stockQ').value = code;
    load();
  });
  const load = async () => {
    const q = $('#stockQ').value.trim();
    const rows = await api('/stock?q=' + encodeURIComponent(q));
    const body = $('#stockBody');
    if (!rows.length) { body.innerHTML = `<div class="empty">ยังไม่มีสต็อก — เริ่มจากการนับสต็อกตั้งต้นในเมนู "สร้างรายการ"</div>`; return; }
    body.innerHTML = `<div class="table-wrap"><table><thead><tr><th>สินค้า</th><th>รหัส</th><th>ตำแหน่ง (ช่อง × จำนวน)</th><th class="right">รวม</th></tr></thead><tbody>
      ${rows.map(r => {
        const hasVariant = r.cells.some(x => x.variant);
        // รวมจำนวนต่อช่อง (ไม่แยกตัวเลือกย่อย) ไว้แสดงแถวหลักให้อ่านง่าย
        const byCell = new Map();
        for (const x of r.cells) byCell.set(x.cell, (byCell.get(x.cell) || 0) + x.qty);
        return `<tr>
        <td>${esc(r.name)} ${hasVariant ? `<button type="button" class="btn-ghost btn-sm" data-detail="${r.id}" title="ดูรายละเอียดแยกตัวเลือก">⋮</button>` : ''}</td>
        <td class="muted">${esc(r.code)}</td>
        <td>${[...byCell].map(([cell, qty]) => `<span class="pill pill-cell">${esc(cell)} · ${qty}</span>`).join(' ')}</td>
        <td class="right"><b>${r.total}</b> ${esc(r.unit || '')}</td>
      </tr>`;
      }).join('')}
    </tbody></table></div>`;
    body.querySelectorAll('[data-detail]').forEach(b => b.onclick = () => {
      const r = rows.find(x => x.id == b.dataset.detail);
      const byVariant = new Map();
      for (const x of r.cells) {
        const key = x.variant || '(ไม่ระบุตัวเลือก)';
        if (!byVariant.has(key)) byVariant.set(key, []);
        byVariant.get(key).push(x);
      }
      modal(`<h3>${esc(r.name)}</h3>
        <p class="muted" style="font-size:13px;margin-bottom:10px">แยกตามตัวเลือก (สี/ไซส์/อื่นๆ)</p>
        <div class="table-wrap"><table><thead><tr><th>ตัวเลือก</th><th>ช่อง × จำนวน</th><th class="right">รวม</th></tr></thead><tbody>
        ${[...byVariant].map(([variant, cells]) => `<tr>
          <td>${esc(variant)}</td>
          <td>${cells.map(c => `<span class="pill pill-cell">${esc(c.cell)} · ${c.qty}</span>`).join(' ')}</td>
          <td class="right"><b>${cells.reduce((s, c) => s + c.qty, 0)}</b></td>
        </tr>`).join('')}
        </tbody></table></div>`,
        () => true);
      // โหมดดูอย่างเดียว — ซ่อนปุ่มบันทึก เหลือแค่ปิด
      document.querySelector('.modal [data-ok]').classList.add('hidden');
      document.querySelector('.modal [data-x]').textContent = 'ปิด';
    });
  };
  $('#stockQ').addEventListener('input', debounce(load, 250));
  load();
}

// ---------- MOVEMENT (สร้างรายการ) ----------
async function viewMovement() {
  const c = $('#content');
  c.innerHTML = `<div class="panel">
    <h2>สร้างรายการเคลื่อนไหว</h2>
    <p class="desc">ทุกรายการต้องมีคนอื่นยืนยัน (กฎสองมือ) ก่อนของจะขยับจริง</p>
    <div class="row">
      <div><label class="lbl">ประเภท</label>
        <select id="mvType">
          <option value="import">นำเข้า (รับของเข้าช่อง)</option>
          <option value="withdraw">เบิกออก (จ่ายของออกจากช่อง)</option>
          <option value="move">ย้ายช่อง</option>
          <option value="initial">นับสต็อกตั้งต้น</option>
        </select>
      </div>
    </div>
    <div class="row" style="margin-top:12px">
      <div style="flex:2"><label class="lbl">สินค้า</label>
        <div style="display:flex;gap:8px">
          <input id="mvProdSearch" placeholder="พิมพ์รหัส/ชื่อ แล้วเลือก" style="flex:1">
          <button type="button" class="btn btn-sky btn-sm" id="mvScanBtn" title="สแกนบาร์โค้ด">📷 สแกน</button>
        </div>
        <div id="mvProdList"></div>
        <div id="mvProdChosen" class="muted" style="margin-top:6px"></div>
      </div>
    </div>
    <div class="row" style="margin-top:12px">
      <div id="fromWrap"><label class="lbl">ช่องต้นทาง</label><select id="mvFrom"></select>
        <div id="fromHint" class="muted" style="font-size:12px;margin-top:4px"></div></div>
      <div id="toWrap"><label class="lbl">ช่องปลายทาง</label><select id="mvTo"></select></div>
    </div>
    <div style="margin-top:16px">
      <label class="lbl">จำนวน (ถ้าสินค้ามีหลายแบบ เช่น สี/ไซส์ ต่างกัน — เพิ่มได้หลายแถว)</label>
      <div id="mvLines"></div>
      <button type="button" class="btn-ghost btn-sm" id="mvAddLine" style="margin-top:8px">+ เพิ่มรายละเอียด (สี/ไซส์/อื่นๆ)</button>
    </div>
    <div class="row" style="margin-top:14px"><div><label class="lbl">หมายเหตุรวม (ถ้ามี)</label><input id="mvNote" placeholder="เช่น เบิกไปสาขา 2"></div></div>
    <div style="margin-top:16px;max-width:260px"><button class="btn btn-primary" id="mvSubmit">บันทึกรายการ (รอยืนยัน)</button></div>
    <p class="err" id="mvErr"></p>
  </div>`;

  let chosen = null;
  const cellOpts = (sel) => `<option value="">— เลือกช่อง —</option>` +
    CELLS.map(x => `<option value="${x.code}"${x.code === sel ? ' selected' : ''}>${x.code} (โซน ${x.zone})</option>`).join('');
  $('#mvTo').innerHTML = cellOpts();
  $('#mvFrom').innerHTML = cellOpts();

  const syncFields = () => {
    const t = $('#mvType').value;
    $('#fromWrap').style.display = (t === 'withdraw' || t === 'move') ? '' : 'none';
    $('#toWrap').style.display = (t === 'import' || t === 'move' || t === 'initial') ? '' : 'none';
    refreshFromHint();
  };
  const refreshFromHint = async () => {
    if (!chosen || $('#fromWrap').style.display === 'none') { $('#fromHint').textContent = ''; return; }
    const st = await api('/stock/product/' + chosen.id);
    $('#fromHint').innerHTML = st.length
      ? 'มีของในช่อง: ' + st.map(s => `<b>${s.cell_code}</b>${s.variant ? ` (${esc(s.variant)})` : ''}=${s.qty}`).join(', ')
      : 'สินค้านี้ยังไม่มีของในระบบ';
  };
  $('#mvType').onchange = syncFields;

  const doSearchProd = async () => {
    const q = $('#mvProdSearch').value.trim();
    if (!q) { $('#mvProdList').innerHTML = ''; return; }
    const { items } = await api('/products?q=' + encodeURIComponent(q) + '&limit=8');
    $('#mvProdList').innerHTML = `<div style="border:1px solid var(--line);border-radius:10px;margin-top:6px;overflow:hidden">
      ${items.map(p => `<div class="pickrow" data-id="${p.id}" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--line)">
        <b>${esc(p.name)}</b> <span class="muted">· ${esc(p.code)} ${p.unit ? '· ' + esc(p.unit) : ''}</span></div>`).join('') || '<div class="muted" style="padding:8px 12px">ไม่พบสินค้า</div>'}
    </div>`;
    $('#mvProdList').querySelectorAll('.pickrow').forEach(r => r.onclick = () => {
      chosen = items.find(p => p.id == r.dataset.id);
      $('#mvProdChosen').innerHTML = `เลือก: <b style="color:var(--ink)">${esc(chosen.name)}</b> (${esc(chosen.code)})`;
      $('#mvProdList').innerHTML = ''; $('#mvProdSearch').value = '';
      refreshFromHint();
    });
  };
  $('#mvProdSearch').addEventListener('input', debounce(doSearchProd, 250));
  $('#mvScanBtn').onclick = () => openScanner(async (code) => {
    const { items } = await api('/products?q=' + encodeURIComponent(code) + '&limit=5');
    const exact = items.find(p => p.code === code || p.barcode2 === code);
    if (exact) {
      chosen = exact;
      $('#mvProdChosen').innerHTML = `เลือก: <b style="color:var(--ink)">${esc(chosen.name)}</b> (${esc(chosen.code)})`;
      $('#mvProdList').innerHTML = ''; $('#mvProdSearch').value = '';
      refreshFromHint();
      toast('สแกนพบสินค้า: ' + chosen.name);
    } else {
      $('#mvProdSearch').value = code;
      doSearchProd();
      toast(items.length ? 'ไม่พบรหัสตรงทุกตัว — แสดงรายการใกล้เคียง' : 'ไม่พบสินค้ารหัสนี้ในระบบ', 'bad');
    }
  });

  // ---------- รายละเอียด/จำนวน (รองรับหลายแบบ เช่น สี/ไซส์ ในการบันทึกครั้งเดียว) ----------
  function addLine(detail = '', qty = '') {
    const row = el(`<div class="row" style="margin-top:8px;align-items:flex-end">
      <div style="flex:2"><input class="mvDetail" placeholder="รายละเอียด (ถ้ามี) เช่น สีแดง ไซส์ M" value="${esc(detail)}"></div>
      <div style="flex:0 0 120px"><input class="mvLineQty" type="number" min="1" placeholder="จำนวน" value="${esc(qty)}"></div>
      <div style="flex:0 0 auto"><button type="button" class="btn-ghost btn-sm" data-remove-line>ลบ</button></div>
    </div>`);
    row.querySelector('[data-remove-line]').onclick = () => {
      if ($('#mvLines').children.length > 1) row.remove();
    };
    $('#mvLines').appendChild(row);
  }
  addLine();
  $('#mvAddLine').onclick = () => addLine();

  $('#mvSubmit').onclick = async () => {
    $('#mvErr').textContent = '';
    if (!chosen) { $('#mvErr').textContent = 'กรุณาเลือกสินค้า'; return; }
    const lines = [...$('#mvLines').children].map(row => ({
      detail: row.querySelector('.mvDetail').value.trim(),
      qty: +row.querySelector('.mvLineQty').value,
    }));
    const valid = lines.filter(l => l.qty > 0);
    if (!valid.length) { $('#mvErr').textContent = 'กรุณาระบุจำนวน (มากกว่า 0) อย่างน้อย 1 แถว'; return; }
    const generalNote = $('#mvNote').value.trim();
    try {
      for (const l of valid) {
        const note = [l.detail, generalNote].filter(Boolean).join(' · ');
        await api('/movements', { method: 'POST', body: {
          type: $('#mvType').value, product_id: chosen.id, qty: l.qty, variant: l.detail,
          from_cell: $('#mvFrom').value || null, to_cell: $('#mvTo').value || null, note,
        } });
      }
      toast(valid.length > 1 ? `บันทึก ${valid.length} รายการแล้ว — รอคนอื่นยืนยัน` : 'บันทึกแล้ว — รอคนอื่นยืนยัน');
      chosen = null; viewMovement();
    } catch (e) { $('#mvErr').textContent = e.message; }
  };
  syncFields();
}

// ---------- PENDING (รออนุมัติ) ----------
async function viewPending() {
  const c = $('#content');
  const [mv, edits] = await Promise.all([api('/movements/pending'), api('/edits/pending')]);
  c.innerHTML = `<div class="panel">
    <h2>รายการรออนุมัติ <span class="muted" style="font-size:14px">(${mv.length})</span></h2>
    <p class="desc">ยืนยันได้เฉพาะรายการที่ "คนอื่น" สร้าง — ยืนยันของตัวเองไม่ได้</p>
    <div id="pendBody"></div>
  </div>
  <div class="panel">
    <h2>คำขอแก้ไขรออนุมัติ <span class="muted" style="font-size:14px">(${edits.length})</span></h2>
    <div id="editBody"></div>
  </div>`;

  const pb = $('#pendBody');
  pb.innerHTML = mv.length ? `<div class="table-wrap"><table><thead><tr><th>ประเภท</th><th>สินค้า</th><th>จำนวน</th><th>ช่อง</th><th>คนสร้าง</th><th>เวลา</th><th></th></tr></thead><tbody>
    ${mv.map(m => {
      const mine = m.created_by === ME.id;
      const place = m.type === 'move' ? `${esc(m.from_cell)}→${esc(m.to_cell)}` : esc(m.to_cell || m.from_cell);
      return `<tr>
        <td><span class="tag-type t-${m.type}">${TYPE_TH[m.type]}</span></td>
        <td>${esc(m.product_name)}<br><span class="muted" style="font-size:12px">${esc(m.product_code)}</span></td>
        <td>${m.qty} ${esc(m.unit || '')}</td>
        <td>${place}</td>
        <td>${esc(m.creator_name)}</td>
        <td class="muted" style="font-size:12px">${esc(m.created_at)}</td>
        <td class="right">
          ${mine ? '<span class="muted" style="font-size:12px">รอคนอื่นยืนยัน</span>'
                 : `<button class="btn btn-green btn-sm" data-confirm="${m.id}">ยืนยัน</button>`}
          <button class="btn-ghost btn-sm" data-cancel="${m.id}">ยกเลิก</button>
        </td></tr>`;
    }).join('')}</tbody></table></div>` : `<div class="empty">ไม่มีรายการรออนุมัติ</div>`;

  pb.querySelectorAll('[data-confirm]').forEach(b => b.onclick = async () => {
    try { await api(`/movements/${b.dataset.confirm}/confirm`, { method: 'POST' }); toast('ยืนยันแล้ว'); viewPending(); }
    catch (e) { toast(e.message, 'bad'); }
  });
  pb.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => askReason(async (reason) => {
    await api(`/movements/${b.dataset.cancel}/cancel`, { method: 'POST', body: { reason } });
    toast('ยกเลิกแล้ว'); viewPending();
  }));

  const eb = $('#editBody');
  eb.innerHTML = edits.length ? `<div class="table-wrap"><table><thead><tr><th>สินค้า</th><th>แก้จำนวน</th><th>ผู้ขอแก้</th><th>เวลา</th><th></th></tr></thead><tbody>
    ${edits.map(e => {
      const mine = e.requested_by === ME.id;
      return `<tr><td>${esc(e.product_name)} <span class="muted">(${esc(e.product_code)})</span></td>
        <td><span class="pill pill-red">${e.old_value}</span> → <span class="pill pill-green">${e.new_value}</span></td>
        <td>${esc(e.requester_name)}</td><td class="muted" style="font-size:12px">${esc(e.requested_at)}</td>
        <td class="right">${mine ? '<span class="muted" style="font-size:12px">รอคนอื่นยืนยัน</span>'
          : `<button class="btn btn-green btn-sm" data-econf="${e.id}">ยืนยันการแก้</button>`}</td></tr>`;
    }).join('')}</tbody></table></div>` : `<div class="empty">ไม่มีคำขอแก้ไข</div>`;
  eb.querySelectorAll('[data-econf]').forEach(b => b.onclick = async () => {
    try { await api(`/edits/${b.dataset.econf}/confirm`, { method: 'POST' }); toast('ยืนยันการแก้แล้ว'); viewPending(); }
    catch (e) { toast(e.message, 'bad'); }
  });
}

// ---------- REPORTS ----------
async function viewReports() {
  const c = $('#content');
  const users = can('god') ? await api('/users') : null;
  c.innerHTML = `<div class="panel">
    <h2>รายงานย้อนหลัง</h2>
    <p class="desc">ดูประวัติการเคลื่อนไหว กรองตามสินค้า / พนักงาน / ช่อง</p>
    <div class="row">
      <div><label class="lbl">รหัส/ชื่อสินค้า</label><input id="rpProd" placeholder="พิมพ์แล้วกดค้นหา"></div>
      <div><label class="lbl">ช่อง</label><select id="rpCell"><option value="">ทั้งหมด</option>
        ${CELLS.map(x => `<option>${x.code}</option>`).join('')}</select></div>
      <div style="flex:0"><button class="btn btn-sky btn-sm" id="rpGo" style="margin-bottom:1px">ค้นหา</button></div>
    </div>
    <div id="rpBody" style="margin-top:16px"><div class="empty">เลือกเงื่อนไขแล้วกดค้นหา</div></div>
  </div>`;

  $('#rpGo').onclick = async () => {
    let pid = '';
    const pq = $('#rpProd').value.trim();
    if (pq) { const { items } = await api('/products?q=' + encodeURIComponent(pq) + '&limit=1'); if (items[0]) pid = items[0].id; }
    const params = new URLSearchParams();
    if (pid) params.set('product_id', pid);
    if ($('#rpCell').value) params.set('cell', $('#rpCell').value);
    const rows = await api('/movements?' + params.toString());
    $('#rpBody').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr><th>เวลา</th><th>ประเภท</th><th>สินค้า</th><th>จำนวน</th><th>ช่อง</th><th>คนทำ</th><th>คนยืนยัน</th><th>สถานะ</th></tr></thead><tbody>
      ${rows.map(m => `<tr>
        <td class="muted" style="font-size:12px">${esc(m.created_at)}</td>
        <td><span class="tag-type t-${m.type}">${TYPE_TH[m.type]}</span></td>
        <td>${esc(m.product_name)}<br><span class="muted" style="font-size:12px">${esc(m.product_code)}</span></td>
        <td>${m.qty}</td>
        <td>${m.type === 'move' ? esc(m.from_cell) + '→' + esc(m.to_cell) : esc(m.to_cell || m.from_cell || '')}</td>
        <td>${esc(m.creator_name)}</td>
        <td>${esc(m.confirmer_name || '—')}</td>
        <td>${statusPill(m)}${m.status === 'confirmed' && can('angel') ? ` <button class="btn-ghost btn-sm" data-edit="${m.id}" data-q="${m.qty}">แก้</button>` : ''}</td>
      </tr>`).join('')}</tbody></table></div>` : `<div class="empty">ไม่พบรายการ</div>`;
    $('#rpBody').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => askEdit(b.dataset.edit, b.dataset.q, () => $('#rpGo').click()));
  };
}
function statusPill(m) {
  if (m.status === 'confirmed') return `<span class="pill pill-green">ยืนยันแล้ว</span>`;
  if (m.status === 'pending') return `<span class="pill pill-amber">รออนุมัติ</span>`;
  return `<span class="pill pill-red" title="${esc(m.cancel_reason || '')}">ยกเลิก</span>`;
}

// ---------- PRODUCTS ----------
async function viewProducts() {
  const c = $('#content');
  c.innerHTML = `<div class="panel">
    <h2>สินค้า</h2>
    <p class="desc">ฐานข้อมูลสินค้าทั้งหมด — รหัส (บาร์โค้ด) ห้ามซ้ำ</p>
    <div class="row">
      <div style="display:flex;gap:8px;flex:1">
        <input id="pQ" placeholder="ค้นหารหัส/ชื่อสินค้า" style="flex:1">
        <button type="button" class="btn btn-sky btn-sm" id="pScanBtn" title="สแกนบาร์โค้ด">📷 สแกน</button>
      </div>
      ${can('angel') ? '<div style="flex:0"><button class="btn btn-sky btn-sm" id="pAdd" style="margin-bottom:1px">+ เพิ่มสินค้า</button></div>' : ''}
    </div>
    <div id="pBody" style="margin-top:16px"></div>
  </div>`;
  $('#pScanBtn').onclick = () => openScanner((code) => { $('#pQ').value = code; load(); });
  const load = async () => {
    const { total, items } = await api('/products?q=' + encodeURIComponent($('#pQ').value.trim()));
    $('#pBody').innerHTML = `<p class="muted" style="font-size:13px;margin-bottom:8px">ทั้งหมด ${total.toLocaleString()} รายการ${items.length < total ? ' · แสดง ' + items.length : ''}</p>
      <div class="table-wrap"><table><thead><tr><th>ชื่อสินค้า</th><th>รหัส</th><th>หน่วย</th><th></th></tr></thead><tbody>
      ${items.map(p => `<tr><td>${esc(p.name)}${p.is_custom ? ' <span class="pill pill-amber">รหัสกำหนดเอง</span>' : ''}</td>
        <td class="muted">${esc(p.code)}</td><td>${esc(p.unit || '—')}</td>
        <td class="right">${can('guardian') ? `<button class="btn-ghost btn-sm" data-del="${p.id}">ลบ</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>`;
    $('#pBody').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('ลบสินค้านี้?')) return;
      try { await api('/products/' + b.dataset.del, { method: 'DELETE' }); toast('ลบแล้ว'); load(); }
      catch (e) { toast(e.message, 'bad'); }
    });
  };
  $('#pQ').addEventListener('input', debounce(load, 250));
  if (can('angel')) $('#pAdd').onclick = () => {
    modal(`<h3>เพิ่มสินค้าใหม่</h3>
      <label class="lbl">รหัส/บาร์โค้ด</label>
      <div style="display:flex;gap:8px">
        <input id="npCode" placeholder="สแกนบาร์โค้ด หรือกำหนดเอง" style="flex:1">
        <button type="button" class="btn btn-sky btn-sm" id="npScanBtn" title="สแกนบาร์โค้ด">📷 สแกน</button>
      </div>
      <label class="lbl" style="margin-top:10px">ชื่อสินค้า</label><input id="npName">
      <label class="lbl" style="margin-top:10px">หน่วยนับ</label><input id="npUnit" placeholder="กล่อง / แพ็ค / ด้าม">
      <p class="err" id="npErr"></p>`, async () => {
        try {
          await api('/products', { method: 'POST', body: {
            code: $('#npCode').value, name: $('#npName').value, unit: $('#npUnit').value, is_custom: true } });
          toast('เพิ่มสินค้าแล้ว'); load(); return true;
        } catch (e) { $('#npErr').textContent = e.message; return false; }
      });
    $('#npScanBtn').onclick = () => openScanner((code) => { $('#npCode').value = code; toast('สแกนสำเร็จ'); });
  };
  load();
}

// ---------- ADMIN (จัดการผู้ใช้) ----------
async function viewAdmin() {
  const c = $('#content');
  const users = await api('/users');
  const pending = users.filter(u => !u.approved);
  const active = users.filter(u => u.approved);
  const RL = { intern: 'มนุษย์ฝึกหัด', angel: 'นางฟ้า', guardian: 'เทพพิทักษ์', god: 'เทพเจ้าสูงสุด' };
  const roleOpts = (sel) => Object.entries(RL).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${v}</option>`).join('');
  const appUrl = location.origin + '/';
  c.innerHTML = `<div class="panel">
    <h2>QR สำหรับเข้าใช้งานแอป</h2>
    <p class="desc">ให้พนักงานสแกนด้วยกล้องมือถือเพื่อเปิดหน้าเข้าสู่ระบบ (ต้องสมัครและรออนุมัติก่อนใช้งานได้)</p>
    <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(appUrl)}" alt="QR เข้าใช้งานแอป" width="180" height="180" style="border:1px solid var(--line);border-radius:14px">
      <div>
        <p class="muted" style="font-size:13px;margin-bottom:8px">หรือคัดลอกลิงก์:</p>
        <div style="display:flex;gap:8px">
          <input id="appUrlBox" readonly value="${esc(appUrl)}" style="max-width:280px">
          <button class="btn-ghost btn-sm" id="copyAppUrl">คัดลอก</button>
        </div>
      </div>
    </div>
  </div>
  ${pending.length ? `<div class="panel">
    <h2>คำขอสมัครเข้าใช้งาน <span class="muted" style="font-size:14px">(${pending.length})</span></h2>
    <p class="desc">ผู้สมัครใหม่ — เลือกบทบาทแล้วกดอนุมัติ หรือปฏิเสธคำขอ</p>
    <div class="table-wrap"><table><thead><tr><th>ชื่อ-นามสกุล</th><th>ชื่อผู้ใช้</th><th>กำหนดบทบาท</th><th></th></tr></thead><tbody>
    ${pending.map(u => `<tr><td>${esc(u.full_name)}</td><td class="muted">${esc(u.username)}</td>
      <td><select data-role-for="${u.id}" style="width:auto">${roleOpts('intern')}</select></td>
      <td class="right">
        <button class="btn btn-green btn-sm" data-approve="${u.id}">อนุมัติ</button>
        <button class="btn-ghost btn-sm" data-reject="${u.id}">ปฏิเสธ</button>
      </td></tr>`).join('')}
    </tbody></table></div>
  </div>` : ''}
  <div class="panel">
    <h2>จัดการผู้ใช้</h2>
    <p class="desc">เพิ่มพนักงาน กำหนดบทบาท และระงับบัญชีคนที่ลาออก</p>
    <div style="max-width:200px;margin-bottom:16px"><button class="btn btn-sky btn-sm" id="uAdd">+ เพิ่มผู้ใช้</button></div>
    <div class="table-wrap"><table><thead><tr><th>ชื่อ-นามสกุล</th><th>ชื่อผู้ใช้</th><th>บทบาท</th><th>สถานะ</th><th></th></tr></thead><tbody>
    ${active.map(u => `<tr><td>${esc(u.full_name)}</td><td class="muted">${esc(u.username)}</td>
      <td><span class="pill pill-cell">${RL[u.role]}</span></td>
      <td>${u.active ? '<span class="pill pill-green">ใช้งาน</span>' : '<span class="pill pill-red">ระงับ</span>'}</td>
      <td class="right">
        <button class="btn-ghost btn-sm" data-edit="${u.id}">แก้ไข</button>
        ${u.id !== ME.id ? `<button class="btn-ghost btn-sm" data-tog="${u.id}" data-a="${u.active}">${u.active ? 'ระงับ' : 'เปิดใช้'}</button>` : '<span class="muted" style="font-size:12px">(คุณ)</span>'}
      </td></tr>`).join('')}
    </tbody></table></div></div>`;
  $('#copyAppUrl').onclick = () => {
    $('#appUrlBox').select();
    navigator.clipboard?.writeText(appUrl).then(() => toast('คัดลอกแล้ว')).catch(() => toast('คัดลอกไม่สำเร็จ — เลือกข้อความแล้วกด Ctrl+C เอง', 'bad'));
  };
  c.querySelectorAll('[data-tog]').forEach(b => b.onclick = async () => {
    await api('/users/' + b.dataset.tog, { method: 'PATCH', body: { active: b.dataset.a !== '1' } });
    toast('อัปเดตแล้ว'); viewAdmin();
  });
  c.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => {
    const u = active.find(x => x.id == b.dataset.edit);
    const isSelf = u.id === ME.id;
    modal(`<h3>แก้ไขผู้ใช้</h3>
      <label class="lbl">ชื่อ-นามสกุล</label><input id="euName" value="${esc(u.full_name)}">
      <label class="lbl" style="margin-top:10px">ชื่อผู้ใช้ (สำหรับล็อกอิน)</label><input id="euUser" value="${esc(u.username)}">
      <label class="lbl" style="margin-top:10px">ตั้งรหัสผ่านใหม่ (เว้นว่าง = ไม่เปลี่ยน)</label><input id="euPass" type="text" placeholder="ไม่เปลี่ยนรหัสผ่าน">
      <label class="lbl" style="margin-top:10px">บทบาท</label>
      <select id="euRole" ${isSelf ? 'disabled' : ''}>${Object.entries(RL).map(([k, v]) => `<option value="${k}"${k === u.role ? ' selected' : ''}>${v}</option>`).join('')}</select>
      ${isSelf ? '<p class="muted" style="font-size:12px;margin-top:4px">เปลี่ยนบทบาทตัวเองไม่ได้</p>' : ''}
      ${!isSelf ? `<button type="button" class="btn-ghost" id="euDel" style="margin-top:14px;width:100%;color:var(--red);border-color:var(--red)">ลบบัญชีนี้</button>` : ''}
      <p class="err" id="euErr"></p>`, async () => {
      try {
        const body = { full_name: $('#euName').value, username: $('#euUser').value };
        if (!isSelf) body.role = $('#euRole').value;
        if ($('#euPass').value) body.password = $('#euPass').value;
        await api('/users/' + u.id, { method: 'PATCH', body });
        toast('บันทึกแล้ว'); viewAdmin(); return true;
      } catch (e) { $('#euErr').textContent = e.message; return false; }
    });
    if (!isSelf) {
      $('#euDel').onclick = async () => {
        if (!confirm(`ลบบัญชี "${u.full_name}" ถาวร?`)) return;
        try {
          await api('/users/' + u.id, { method: 'DELETE' });
          toast('ลบแล้ว'); document.querySelector('.modal-bg').remove(); viewAdmin();
        } catch (e) { $('#euErr').textContent = e.message; }
      };
    }
  });
  c.querySelectorAll('[data-approve]').forEach(b => b.onclick = async () => {
    const role = c.querySelector(`[data-role-for="${b.dataset.approve}"]`).value;
    try { await api(`/users/${b.dataset.approve}/approve`, { method: 'POST', body: { role } }); toast('อนุมัติแล้ว'); viewAdmin(); }
    catch (e) { toast(e.message, 'bad'); }
  });
  c.querySelectorAll('[data-reject]').forEach(b => b.onclick = async () => {
    if (!confirm('ปฏิเสธคำขอสมัครนี้?')) return;
    try { await api('/users/' + b.dataset.reject, { method: 'DELETE' }); toast('ปฏิเสธแล้ว'); viewAdmin(); }
    catch (e) { toast(e.message, 'bad'); }
  });
  $('#uAdd').onclick = () => modal(`<h3>เพิ่มผู้ใช้ใหม่</h3>
    <label class="lbl">ชื่อ-นามสกุล</label><input id="nuName">
    <label class="lbl" style="margin-top:10px">ชื่อผู้ใช้ (สำหรับล็อกอิน)</label><input id="nuUser">
    <label class="lbl" style="margin-top:10px">รหัสผ่าน</label><input id="nuPass" type="text">
    <label class="lbl" style="margin-top:10px">บทบาท</label>
    <select id="nuRole"><option value="intern">มนุษย์ฝึกหัด (ดูอย่างเดียว)</option>
      <option value="angel">นางฟ้า (ทำรายการ)</option><option value="guardian">เทพพิทักษ์ (อนุมัติ+ลบ)</option>
      <option value="god">เทพเจ้าสูงสุด (จัดการทุกอย่าง)</option></select>
    <p class="err" id="nuErr"></p>`, async () => {
      try {
        await api('/users', { method: 'POST', body: {
          full_name: $('#nuName').value, username: $('#nuUser').value, password: $('#nuPass').value, role: $('#nuRole').value } });
        toast('เพิ่มผู้ใช้แล้ว'); viewAdmin(); return true;
      } catch (e) { $('#nuErr').textContent = e.message; return false; }
    });
}

// ---------- helpers: modal / reason / edit ----------
function modal(html, onOk) {
  const bg = el(`<div class="modal-bg"><div class="modal">${html}
    <div class="actions"><button class="btn-ghost" data-x style="flex:1">ยกเลิก</button>
    <button class="btn btn-primary" data-ok>บันทึก</button></div></div></div>`);
  document.body.appendChild(bg);
  const close = () => bg.remove();
  bg.querySelector('[data-x]').onclick = close;
  bg.onclick = (e) => { if (e.target === bg) close(); };
  bg.querySelector('[data-ok]').onclick = async () => { const ok = await onOk(); if (ok !== false) close(); };
}
function askReason(onOk) {
  modal(`<h3>เหตุผลการยกเลิก</h3><label class="lbl">ระบุเหตุผล (จำเป็น)</label>
    <textarea id="cxReason" rows="3" placeholder="เช่น สร้างรายการผิด, ลูกค้ายกเลิก"></textarea><p class="err" id="cxErr"></p>`,
    async () => {
      const r = $('#cxReason').value.trim();
      if (!r) { $('#cxErr').textContent = 'ต้องระบุเหตุผล'; return false; }
      try { await onOk(r); return true; } catch (e) { $('#cxErr').textContent = e.message; return false; }
    });
}
function askEdit(id, oldQty, after) {
  modal(`<h3>ขอแก้จำนวน</h3><p class="muted" style="font-size:13px;margin-bottom:10px">จำนวนเดิม: ${oldQty} — ต้องมีคนอื่นยืนยันการแก้</p>
    <label class="lbl">จำนวนใหม่</label><input id="edQty" type="number" min="1" value="${oldQty}"><p class="err" id="edErr"></p>`,
    async () => {
      try { await api(`/movements/${id}/edit`, { method: 'POST', body: { new_qty: +$('#edQty').value } });
        toast('ส่งคำขอแก้แล้ว — รอยืนยัน'); after && after(); return true; }
      catch (e) { $('#edErr').textContent = e.message; return false; }
    });
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------- สแกนบาร์โค้ดด้วยกล้อง ----------
let _beepCtx = null;
function beep() {
  try {
    _beepCtx = _beepCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _beepCtx, osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'square'; osc.frequency.value = 1500;
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.12);
  } catch (_) { /* เบราว์เซอร์บางตัวอาจบล็อกเสียงถ้ายังไม่มี user gesture — ไม่ critical */ }
}
let _scannerLibPromise = null;
function loadScannerLib() {
  if (window.Html5Qrcode) return Promise.resolve();
  if (_scannerLibPromise) return _scannerLibPromise;
  _scannerLibPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
    s.onload = () => resolve();
    s.onerror = () => { _scannerLibPromise = null; reject(new Error('โหลดตัวสแกนไม่สำเร็จ ตรวจสอบอินเทอร์เน็ต')); };
    document.head.appendChild(s);
  });
  return _scannerLibPromise;
}
async function openScanner(onResult) {
  try { await loadScannerLib(); } catch (e) { toast(e.message, 'bad'); return; }
  const bg = el(`<div class="modal-bg"><div class="modal scan-modal">
    <h3>สแกนบาร์โค้ด</h3>
    <div id="scanBox"></div>
    <p class="muted" style="font-size:12.5px;margin-top:10px;text-align:center">เล็งกล้องไปที่บาร์โค้ดสินค้า</p>
    <p class="err" id="scanErr" style="text-align:center"></p>
    <div class="actions"><button class="btn-ghost" data-x style="flex:1">ปิด</button></div>
  </div></div>`);
  document.body.appendChild(bg);
  let inst = new Html5Qrcode('scanBox');
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    try { await inst.stop(); } catch (_) {}
    try { await inst.clear(); } catch (_) {}
    bg.remove();
  };
  bg.querySelector('[data-x]').onclick = stop;
  bg.onclick = (e) => { if (e.target === bg) stop(); };
  const formats = window.Html5QrcodeSupportedFormats ? [
    Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
    Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
    Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
    Html5QrcodeSupportedFormats.ITF, Html5QrcodeSupportedFormats.QR_CODE,
  ] : undefined;
  try {
    await inst.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 260, height: 160 }, formatsToSupport: formats },
      async (decodedText) => { const text = decodedText; beep(); await stop(); onResult(text); },
      () => {} // เรียกบ่อยตอนยังหาบาร์โค้ดไม่เจอ — เงียบไว้
    );
  } catch (e) {
    $('#scanErr').textContent = 'เปิดกล้องไม่สำเร็จ — ตรวจสอบสิทธิ์การใช้กล้อง (' + (e.message || e) + ')';
  }
}

// ---------- auto-login ถ้ามี session ----------
(async () => { try { ME = await api('/me'); await boot(); } catch { /* แสดงหน้า login */ } })();
