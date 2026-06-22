// src/seed.js — เตรียมข้อมูลตั้งต้น: ช่องเก็บ + สินค้า 12,166 รายการ + ผู้ใช้ตัวอย่าง
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { hashPassword } = require('./auth');

// ---------- 1) ช่องเก็บสินค้าตามผังโกดัง ----------
function buildCells() {
  const cells = [];
  for (let i = 1; i <= 8; i++) cells.push([`A${String(i).padStart(2, '0')}`, 'A']);
  for (let i = 1; i <= 6; i++) cells.push([`B${String(i).padStart(2, '0')}`, 'B']);
  for (let i = 1; i <= 6; i++) cells.push([`C${String(i).padStart(2, '0')}`, 'C']);
  for (let i = 1; i <= 6; i++) cells.push([`D${String(i).padStart(2, '0')}`, 'D']);
  for (let r = 1; r <= 4; r++)
    for (let i = 1; i <= 14; i++) cells.push([`R${r}-${String(i).padStart(2, '0')}`, 'R']);
  return cells;
}

function parseCSV(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); field = ''; row = []; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

async function main() {
  await db.init();

  const cells = buildCells();
  await db.withTransaction(async (client) => {
    for (const [code, zone] of cells) {
      await client.run('INSERT INTO cells (code, zone) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING', [code, zone]);
    }
  });
  console.log(`✓ สร้างช่องเก็บ: ${cells.length} ช่อง (B06 = ประตูทางเข้า)`);

  // ---------- 2) ผู้ใช้ ----------
  const seedUsers = [
    ['admin', 'ผู้ดูแลระบบ', 'god', 'admin045'],
    ['guardian', 'สมศักดิ์ (หัวหน้าคลัง)', 'guardian', '1234'],
    ['angel1', 'มาลี (พนักงานคลัง)', 'angel', '1234'],
    ['angel2', 'ปิติ (พนักงานคลัง)', 'angel', '1234'],
    ['intern', 'น้องใหม่ (ฝึกหัด)', 'intern', '1234'],
  ];
  for (const [u, name, role, pw] of seedUsers) {
    await db.run(
      'INSERT INTO users (username, password_hash, full_name, role) VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO NOTHING',
      [u, hashPassword(pw), name, role]
    );
  }
  console.log('✓ สร้างผู้ใช้:');
  console.log('   admin / admin045   (เทพเจ้าสูงสุด — บัญชีหลัก)');
  console.log('   guardian, angel1, angel2, intern / 1234   (ผู้ใช้ตัวอย่างไว้ทดสอบ)');

  // ---------- 3) นำเข้าสินค้าจาก CSV ----------
  const csvPath = path.join(__dirname, '..', 'data', 'products_seed.csv');
  const raw = fs.readFileSync(csvPath, 'utf8');
  const parsed = parseCSV(raw);
  parsed.shift(); // header: barcode,name,unit

  const valid = parsed
    .map(([code, name, unit]) => [code && code.trim(), name && name.trim(), (unit || '').trim() || null])
    .filter(([code, name]) => code && name);

  const BATCH = 500;
  let count = 0;
  for (let i = 0; i < valid.length; i += BATCH) {
    const batch = valid.slice(i, i + BATCH);
    const values = [];
    const params = [];
    batch.forEach(([code, name, unit], idx) => {
      const n = idx * 3;
      values.push(`($${n + 1}, $${n + 2}, $${n + 3}, false)`);
      params.push(code, name, unit);
    });
    await db.run(
      `INSERT INTO products (code, name, unit, is_custom) VALUES ${values.join(',')} ON CONFLICT (code) DO NOTHING`,
      params
    );
    count += batch.length;
    console.log(`  ...นำเข้าแล้ว ${Math.min(i + BATCH, valid.length)}/${valid.length}`);
  }
  console.log(`✓ นำเข้าสินค้า: ${count} รายการ`);

  const total = (await db.get('SELECT COUNT(*) c FROM products')).c;
  console.log(`\nเสร็จสิ้น — ฐานข้อมูลพร้อมใช้งาน (สินค้าทั้งหมด ${total} รายการ)`);
  console.log('ยอดสต็อกและตำแหน่งช่อง: ยังว่าง รอกรอกผ่าน "โหมดนับสต็อกตั้งต้น"');
  await db.pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
