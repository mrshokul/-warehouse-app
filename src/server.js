// src/server.js — เซิร์ฟเวอร์หลัก: API + กฎสองมือ + สิทธิ์ตามบทบาท
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./db');
const auth = require('./auth');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

const RANK = { intern: 0, angel: 1, guardian: 2, god: 3 };
const ROLE_TH = { intern: 'มนุษย์ฝึกหัด', angel: 'นางฟ้า', guardian: 'เทพพิทักษ์', god: 'เทพเจ้าสูงสุด' };

// ห่อ async handler ทุกตัวให้ส่ง error เข้า express error handler แทนการ crash
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- middleware ----------
async function currentUser(req) {
  const sess = await auth.getSession(req.cookies.sid);
  if (!sess) return null;
  return db.get('SELECT id, username, full_name, role, active FROM users WHERE id=$1', [sess.userId]);
}
const requireAuth = h(async (req, res, next) => {
  const u = await currentUser(req);
  if (!u || !u.active) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  req.user = u;
  next();
});
function requireRank(minRole) {
  return (req, res, next) => {
    if (RANK[req.user.role] < RANK[minRole])
      return res.status(403).json({ error: 'สิทธิ์ไม่เพียงพอสำหรับการกระทำนี้' });
    next();
  };
}

// ---------- stock helper ----------
async function addStock(client, product_id, cell, delta) {
  const row = await client.get('SELECT qty FROM stock_by_cell WHERE product_id=$1 AND cell_code=$2', [product_id, cell]);
  const cur = row ? row.qty : 0;
  const next = cur + delta;
  if (next < 0) throw new Error(`สต็อกในช่อง ${cell} ไม่พอ (มี ${cur}, ต้องการ ${-delta})`);
  if (row) {
    if (next === 0) await client.run('DELETE FROM stock_by_cell WHERE product_id=$1 AND cell_code=$2', [product_id, cell]);
    else await client.run('UPDATE stock_by_cell SET qty=$1 WHERE product_id=$2 AND cell_code=$3', [next, product_id, cell]);
  } else {
    await client.run('INSERT INTO stock_by_cell (product_id, cell_code, qty) VALUES ($1, $2, $3)', [product_id, cell, delta]);
  }
}
// ใช้ stock change ตามชนิดรายการ (sign=+1 ยืนยัน, -1 ย้อนกลับ)
async function applyMovementStock(client, m, sign = 1) {
  if (m.type === 'import' || m.type === 'initial') await addStock(client, m.product_id, m.to_cell, sign * m.qty);
  else if (m.type === 'withdraw') await addStock(client, m.product_id, m.from_cell, -sign * m.qty);
  else if (m.type === 'move') {
    await addStock(client, m.product_id, m.from_cell, -sign * m.qty);
    await addStock(client, m.product_id, m.to_cell, sign * m.qty);
  }
}

// ===================== AUTH =====================
app.post('/api/login', h(async (req, res) => {
  const { username, password } = req.body;
  const u = await db.get('SELECT * FROM users WHERE username=$1', [username || '']);
  if (!u || !auth.verifyPassword(password || '', u.password_hash))
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  if (!u.approved) return res.status(403).json({ error: 'บัญชีนี้กำลังรอเจ้าของร้าน/ผู้ดูแลระบบอนุมัติ' });
  if (!u.active) return res.status(403).json({ error: 'บัญชีนี้ถูกระงับการใช้งาน' });
  const token = await auth.createSession(u.id);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, role_th: ROLE_TH[u.role] });
}));

// สมัครบัญชีใหม่ (เปิดสาธารณะ) — เข้าใช้งานไม่ได้จนกว่าเจ้าของร้าน/admin จะอนุมัติ
app.post('/api/register', h(async (req, res) => {
  const { username, password, full_name } = req.body;
  if (!username || !password || !full_name)
    return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  if (password.length < 4) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร' });
  if (await db.get('SELECT id FROM users WHERE username=$1', [username.trim()]))
    return res.status(409).json({ error: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว' });
  await db.run(
    `INSERT INTO users (username, password_hash, full_name, role, approved) VALUES ($1, $2, $3, 'intern', false)`,
    [username.trim(), auth.hashPassword(password), full_name.trim()]
  );
  res.json({ ok: true, message: 'ส่งคำขอสมัครแล้ว รอเจ้าของร้าน/ผู้ดูแลระบบอนุมัติ' });
}));

app.post('/api/logout', h(async (req, res) => {
  await auth.destroySession(req.cookies.sid);
  res.clearCookie('sid');
  res.json({ ok: true });
}));

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ ...req.user, role_th: ROLE_TH[req.user.role] });
});

// ===================== CELLS =====================
app.get('/api/cells', requireAuth, h(async (req, res) => {
  res.json(await db.all('SELECT code, zone FROM cells ORDER BY zone, code'));
}));

// ===================== PRODUCTS =====================
app.get('/api/products', requireAuth, h(async (req, res) => {
  const q = (req.query.q || '').trim();
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  let rows;
  if (q) {
    rows = await db.all(
      `SELECT id, code, name, unit, is_custom, barcode2 FROM products
       WHERE is_deleted=false AND (code ILIKE $1 OR barcode2 ILIKE $1 OR name ILIKE $1)
       ORDER BY (code = $3 OR barcode2 = $3) DESC, name LIMIT $2`,
      [`%${q}%`, limit, q]
    );
  } else {
    rows = await db.all('SELECT id, code, name, unit, is_custom, barcode2 FROM products WHERE is_deleted=false ORDER BY name LIMIT $1', [limit]);
  }
  const total = (await db.get('SELECT COUNT(*) c FROM products WHERE is_deleted=false')).c;
  res.json({ total: +total, items: rows });
}));

// สร้างสินค้า (นางฟ้าขึ้นไป) — code ห้ามซ้ำ
app.post('/api/products', requireAuth, requireRank('angel'), h(async (req, res) => {
  const { code, name, unit, is_custom } = req.body;
  if (!code || !name) return res.status(400).json({ error: 'ต้องระบุรหัสและชื่อสินค้า' });
  const exists = await db.get('SELECT id FROM products WHERE code=$1', [code.trim()]);
  if (exists) return res.status(409).json({ error: `รหัส "${code}" ถูกใช้แล้ว กรุณาใช้รหัสอื่น` });
  const info = await db.get(
    'INSERT INTO products (code, name, unit, is_custom, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [code.trim(), name.trim(), (unit || '').trim() || null, !!is_custom, req.user.id]
  );
  res.json({ id: info.id });
}));

// ลบสินค้า (เทพพิทักษ์ขึ้นไป) — soft delete, ห้ามลบถ้ายังมีสต็อก
app.delete('/api/products/:id', requireAuth, requireRank('guardian'), h(async (req, res) => {
  const id = +req.params.id;
  const stock = (await db.get('SELECT COALESCE(SUM(qty),0) s FROM stock_by_cell WHERE product_id=$1', [id])).s;
  if (stock > 0) return res.status(400).json({ error: 'ลบไม่ได้: สินค้านี้ยังมีของคงเหลือในโกดัง' });
  await db.run('UPDATE products SET is_deleted=true WHERE id=$1', [id]);
  res.json({ ok: true });
}));

// ===================== STOCK =====================
// ยอดคงเหลือปัจจุบัน: รวมต่อสินค้า + รายช่อง
app.get('/api/stock', requireAuth, h(async (req, res) => {
  const q = (req.query.q || '').trim();
  const base = `
    SELECT p.id, p.code, p.name, p.unit,
           s.cell_code, s.qty
    FROM stock_by_cell s JOIN products p ON p.id=s.product_id
    WHERE p.is_deleted=false`;
  const rows = q
    ? await db.all(base + ' AND (p.code ILIKE $1 OR p.name ILIKE $1) ORDER BY p.name, s.cell_code', [`%${q}%`])
    : await db.all(base + ' ORDER BY p.name, s.cell_code');
  // จัดกลุ่มต่อสินค้า
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.id)) map.set(r.id, { id: r.id, code: r.code, name: r.name, unit: r.unit, total: 0, cells: [] });
    const o = map.get(r.id);
    o.total += r.qty;
    o.cells.push({ cell: r.cell_code, qty: r.qty });
  }
  res.json([...map.values()]);
}));

// ยอดของสินค้าหนึ่งตัว (ไว้เลือกช่องตอนเบิก)
app.get('/api/stock/product/:id', requireAuth, h(async (req, res) => {
  res.json(await db.all('SELECT cell_code, qty FROM stock_by_cell WHERE product_id=$1 ORDER BY cell_code', [+req.params.id]));
}));

// ===================== MOVEMENTS =====================
// สร้างรายการ (นางฟ้าขึ้นไป) -> สถานะ pending, ยังไม่กระทบสต็อก
app.post('/api/movements', requireAuth, requireRank('angel'), h(async (req, res) => {
  const { type, product_id, qty, from_cell, to_cell, note } = req.body;
  if (!['import', 'withdraw', 'move', 'initial'].includes(type))
    return res.status(400).json({ error: 'ประเภทรายการไม่ถูกต้อง' });
  if (!product_id || !qty || qty <= 0)
    return res.status(400).json({ error: 'ต้องระบุสินค้าและจำนวน (มากกว่า 0)' });
  if ((type === 'import' || type === 'initial') && !to_cell)
    return res.status(400).json({ error: 'ต้องระบุช่องปลายทาง' });
  if (type === 'withdraw' && !from_cell)
    return res.status(400).json({ error: 'ต้องระบุช่องต้นทาง' });
  if (type === 'move' && (!from_cell || !to_cell))
    return res.status(400).json({ error: 'ต้องระบุช่องต้นทางและปลายทาง' });

  const info = await db.get(
    `INSERT INTO movements (type, product_id, qty, from_cell, to_cell, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [type, product_id, qty, from_cell || null, to_cell || null, (note || '').trim() || null, req.user.id]
  );
  res.json({ id: info.id });
}));

// รายการรออนุมัติทั้งหมด
app.get('/api/movements/pending', requireAuth, h(async (req, res) => {
  res.json(await db.all(`
    SELECT m.*, p.code AS product_code, p.name AS product_name, p.unit,
           cu.full_name AS creator_name
    FROM movements m
    JOIN products p ON p.id=m.product_id
    JOIN users cu ON cu.id=m.created_by
    WHERE m.status='pending' ORDER BY m.created_at DESC`));
}));

// ยืนยันรายการ (กฎสองมือ: ผู้ยืนยัน ≠ ผู้ทำ, นางฟ้าขึ้นไป)
app.post('/api/movements/:id/confirm', requireAuth, requireRank('angel'), h(async (req, res) => {
  const id = +req.params.id;
  const m = await db.get('SELECT * FROM movements WHERE id=$1', [id]);
  if (!m) return res.status(404).json({ error: 'ไม่พบรายการ' });
  if (m.status !== 'pending') return res.status(400).json({ error: 'รายการนี้ไม่ได้อยู่ในสถานะรออนุมัติ' });
  if (m.created_by === req.user.id)
    return res.status(403).json({ error: 'กฎสองมือ: ยืนยันรายการที่ตัวเองสร้างไม่ได้ ต้องให้คนอื่นยืนยัน' });
  try {
    await db.withTransaction(async (client) => {
      await applyMovementStock(client, m, 1);
      await client.run(`UPDATE movements SET status='confirmed', confirmed_by=$1, confirmed_at=now() WHERE id=$2`, [req.user.id, id]);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// ยกเลิกรายการที่รออนุมัติ (ต้องระบุเหตุผล)
app.post('/api/movements/:id/cancel', requireAuth, requireRank('angel'), h(async (req, res) => {
  const id = +req.params.id;
  const reason = (req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'ต้องระบุเหตุผลการยกเลิก' });
  const m = await db.get('SELECT * FROM movements WHERE id=$1', [id]);
  if (!m) return res.status(404).json({ error: 'ไม่พบรายการ' });
  if (m.status !== 'pending') return res.status(400).json({ error: 'ยกเลิกได้เฉพาะรายการที่รออนุมัติ' });
  await db.run(`UPDATE movements SET status='cancelled', cancelled_by=$1, cancelled_at=now(), cancel_reason=$2 WHERE id=$3`, [req.user.id, reason, id]);
  res.json({ ok: true });
}));

// ประวัติ/รายงาน: กรองตามสินค้า / ผู้ทำ / ช่อง
app.get('/api/movements', requireAuth, h(async (req, res) => {
  const { product_id, user_id, cell } = req.query;
  const where = [], args = [];
  if (product_id) { args.push(+product_id); where.push(`m.product_id=$${args.length}`); }
  if (user_id) { args.push(+user_id); where.push(`(m.created_by=$${args.length} OR m.confirmed_by=$${args.length})`); }
  if (cell) { args.push(cell); where.push(`(m.from_cell=$${args.length} OR m.to_cell=$${args.length})`); }
  const sql = `
    SELECT m.*, p.code AS product_code, p.name AS product_name, p.unit,
           cu.full_name AS creator_name, vu.full_name AS confirmer_name
    FROM movements m
    JOIN products p ON p.id=m.product_id
    JOIN users cu ON cu.id=m.created_by
    LEFT JOIN users vu ON vu.id=m.confirmed_by
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY m.created_at DESC LIMIT 300`;
  res.json(await db.all(sql, args));
}));

// ===================== EDIT (รายการที่ยืนยันแล้ว) =====================
// ขอแก้จำนวนของรายการที่ยืนยันแล้ว -> สร้างคำขอแก้ (pending)
app.post('/api/movements/:id/edit', requireAuth, requireRank('angel'), h(async (req, res) => {
  const id = +req.params.id;
  const newQty = +req.body.new_qty;
  const m = await db.get('SELECT * FROM movements WHERE id=$1', [id]);
  if (!m) return res.status(404).json({ error: 'ไม่พบรายการ' });
  if (m.status !== 'confirmed') return res.status(400).json({ error: 'แก้ได้เฉพาะรายการที่ยืนยันแล้ว' });
  if (!newQty || newQty <= 0) return res.status(400).json({ error: 'จำนวนใหม่ต้องมากกว่า 0' });
  const pending = await db.get(`SELECT id FROM edit_history WHERE movement_id=$1 AND status='pending'`, [id]);
  if (pending) return res.status(400).json({ error: 'รายการนี้มีคำขอแก้ที่รอยืนยันอยู่แล้ว' });
  const info = await db.get(
    `INSERT INTO edit_history (movement_id, field, old_value, new_value, requested_by)
     VALUES ($1, 'qty', $2, $3, $4) RETURNING id`,
    [id, String(m.qty), String(newQty), req.user.id]
  );
  res.json({ id: info.id });
}));

// คำขอแก้ที่รอยืนยัน
app.get('/api/edits/pending', requireAuth, h(async (req, res) => {
  res.json(await db.all(`
    SELECT e.*, m.type, m.from_cell, m.to_cell,
           p.code AS product_code, p.name AS product_name,
           ru.full_name AS requester_name
    FROM edit_history e
    JOIN movements m ON m.id=e.movement_id
    JOIN products p ON p.id=m.product_id
    JOIN users ru ON ru.id=e.requested_by
    WHERE e.status='pending' ORDER BY e.requested_at DESC`));
}));

// ยืนยันคำขอแก้ (กฎสองมือ: ผู้ยืนยัน ≠ ผู้ขอแก้) -> ปรับสต็อกตามส่วนต่าง
app.post('/api/edits/:id/confirm', requireAuth, requireRank('angel'), h(async (req, res) => {
  const id = +req.params.id;
  const e = await db.get('SELECT * FROM edit_history WHERE id=$1', [id]);
  if (!e) return res.status(404).json({ error: 'ไม่พบคำขอแก้' });
  if (e.status !== 'pending') return res.status(400).json({ error: 'คำขอนี้ถูกดำเนินการแล้ว' });
  if (e.requested_by === req.user.id)
    return res.status(403).json({ error: 'กฎสองมือ: ยืนยันคำขอแก้ของตัวเองไม่ได้' });
  const m = await db.get('SELECT * FROM movements WHERE id=$1', [e.movement_id]);
  const oldQty = +e.old_value, newQty = +e.new_value, delta = newQty - oldQty;
  try {
    await db.withTransaction(async (client) => {
      // ปรับสต็อกตามชนิดรายการด้วยส่วนต่าง
      const fake = { ...m, qty: Math.abs(delta) };
      if (delta !== 0) await applyMovementStock(client, fake, delta > 0 ? 1 : -1);
      await client.run('UPDATE movements SET qty=$1 WHERE id=$2', [newQty, m.id]);
      await client.run(`UPDATE edit_history SET status='confirmed', confirmed_by=$1, confirmed_at=now() WHERE id=$2`, [req.user.id, id]);
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// ===================== USERS (god) =====================
app.get('/api/users', requireAuth, requireRank('god'), h(async (req, res) => {
  res.json(await db.all('SELECT id, username, full_name, role, active, approved FROM users ORDER BY approved ASC, role DESC, full_name'));
}));
// อนุมัติบัญชีที่สมัครเข้ามา — กำหนดบทบาทพร้อมกัน
app.post('/api/users/:id/approve', requireAuth, requireRank('god'), h(async (req, res) => {
  const id = +req.params.id;
  const role = req.body.role;
  if (!RANK.hasOwnProperty(role)) return res.status(400).json({ error: 'บทบาทไม่ถูกต้อง' });
  const u = await db.get('SELECT id FROM users WHERE id=$1 AND approved=false', [id]);
  if (!u) return res.status(404).json({ error: 'ไม่พบคำขอสมัครนี้ หรืออนุมัติไปแล้ว' });
  await db.run('UPDATE users SET approved=true, role=$1 WHERE id=$2', [role, id]);
  res.json({ ok: true });
}));
// ลบบัญชี — ลบได้เฉพาะกรณีไม่มีประวัติการทำรายการผูกอยู่ (ป้องกันข้อมูลอ้างอิงขาด)
app.delete('/api/users/:id', requireAuth, requireRank('god'), h(async (req, res) => {
  const id = +req.params.id;
  if (id === req.user.id) return res.status(400).json({ error: 'ลบบัญชีตัวเองไม่ได้' });
  const exists = await db.get('SELECT id FROM users WHERE id=$1', [id]);
  if (!exists) return res.status(404).json({ error: 'ไม่พบผู้ใช้นี้' });
  const linked = await db.get(
    `SELECT 1 AS x FROM movements WHERE created_by=$1 OR confirmed_by=$1 OR cancelled_by=$1
     UNION SELECT 1 FROM edit_history WHERE requested_by=$1 OR confirmed_by=$1 LIMIT 1`,
    [id]
  );
  if (linked) return res.status(400).json({ error: 'ลบไม่ได้: บัญชีนี้มีประวัติการทำรายการผูกอยู่ — ใช้ "ระงับ" แทน' });
  await db.run('DELETE FROM sessions WHERE user_id=$1', [id]);
  await db.run('DELETE FROM users WHERE id=$1', [id]);
  res.json({ ok: true });
}));
app.post('/api/users', requireAuth, requireRank('god'), h(async (req, res) => {
  const { username, password, full_name, role } = req.body;
  if (!username || !password || !full_name || !RANK.hasOwnProperty(role))
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  if (await db.get('SELECT id FROM users WHERE username=$1', [username]))
    return res.status(409).json({ error: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว' });
  const info = await db.get(
    'INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id',
    [username.trim(), auth.hashPassword(password), full_name.trim(), role]
  );
  res.json({ id: info.id });
}));
app.patch('/api/users/:id', requireAuth, requireRank('god'), h(async (req, res) => {
  const id = +req.params.id;
  const { active, role, full_name, username, password } = req.body;
  if (typeof active === 'boolean') {
    if (id === req.user.id) return res.status(400).json({ error: 'ระงับบัญชีตัวเองไม่ได้' });
    await db.run('UPDATE users SET active=$1 WHERE id=$2', [active, id]);
  }
  if (role && RANK.hasOwnProperty(role))
    await db.run('UPDATE users SET role=$1 WHERE id=$2', [role, id]);
  if (typeof full_name === 'string' && full_name.trim())
    await db.run('UPDATE users SET full_name=$1 WHERE id=$2', [full_name.trim(), id]);
  if (typeof username === 'string' && username.trim()) {
    const dupe = await db.get('SELECT id FROM users WHERE username=$1 AND id<>$2', [username.trim(), id]);
    if (dupe) return res.status(409).json({ error: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว' });
    await db.run('UPDATE users SET username=$1 WHERE id=$2', [username.trim(), id]);
  }
  if (typeof password === 'string' && password) {
    if (password.length < 4) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 4 ตัวอักษร' });
    await db.run('UPDATE users SET password_hash=$1 WHERE id=$2', [auth.hashPassword(password), id]);
  }
  res.json({ ok: true });
}));

// ---------- error handler ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
});

// รันเซิร์ฟเวอร์เองเฉพาะตอน node src/server.js โดยตรง (ไม่ใช่ตอนถูก require บน Vercel)
if (require.main === module) {
  db.init().then(() => {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`\n🌤️  ฟ้าตระการมอลล์ WMS ทำงานที่ http://localhost:${PORT}\n`));
  });
} else {
  db.init().catch((e) => console.error('DB init error:', e));
}

module.exports = app;
