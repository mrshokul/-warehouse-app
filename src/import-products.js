// src/import-products.js — อัปเดตข้อมูลสินค้าจากไฟล์ CSV ใหม่ (รองรับบาร์โค้ดสำรอง barcode2)
// ใช้แทนที่ npm run seed สำหรับการ "รีเฟรช" ข้อมูลสินค้าโดยไม่กระทบสต็อก/รายการที่มีอยู่แล้ว
// วิธีใช้: node src/import-products.js [path-to-csv]   (default: data/products_seed_v2.csv)
const fs = require('fs');
const path = require('path');
const db = require('./db');

function parseCSV(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
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
  const csvPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data', 'products_seed_v2.csv'));
  const raw = fs.readFileSync(csvPath, 'utf8');
  const parsed = parseCSV(raw);
  parsed.shift(); // header: code,barcode2,name,unit

  const valid = parsed
    .map(([code, barcode2, name, unit]) => [
      code && code.trim(), (barcode2 || '').trim() || null,
      name && name.trim(), (unit || '').trim() || null,
    ])
    .filter(([code, , name]) => code && name);
  console.log(`อ่านจากไฟล์: ${valid.length} รายการ`);

  // TEMP TABLE ผูกกับ connection เดียว — ต้องใช้ client ตัวเดียวตลอด ไม่ใช่ pool.query (ซึ่งสุ่ม connection ทุกครั้ง)
  const client = await db.pool.connect();
  try {
    await client.query('DROP TABLE IF EXISTS tmp_import');
    await client.query('CREATE TEMP TABLE tmp_import (code TEXT, barcode2 TEXT, name TEXT, unit TEXT)');

    const BATCH = 500;
    for (let i = 0; i < valid.length; i += BATCH) {
      const batch = valid.slice(i, i + BATCH);
      const values = [], params = [];
      batch.forEach(([code, barcode2, name, unit], idx) => {
        const n = idx * 4;
        values.push(`($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4})`);
        params.push(code, barcode2, name, unit);
      });
      await client.query(`INSERT INTO tmp_import (code, barcode2, name, unit) VALUES ${values.join(',')}`, params);
      console.log(`  ...โหลดเข้า temp table ${Math.min(i + BATCH, valid.length)}/${valid.length}`);
    }

    // อัปเดตสินค้าที่มีอยู่แล้ว — จับคู่ด้วยรหัสหลักหรือบาร์โค้ดสำรอง (ไม่ลบ/ไม่แก้สถานะอื่น)
    // หมายเหตุ: ไม่เปลี่ยนค่า p.code เด็ดขาด (เลี่ยงชนกับ UNIQUE constraint ตอน batch update)
    // แต่จะเติมบาร์โค้ดอีกตัวลง barcode2 เสมอ เพื่อให้ค้นหา/สแกนด้วยบาร์โค้ดไหนก็เจอ
    const upd = await client.query(`
      UPDATE products p SET name = t.name, unit = t.unit,
        barcode2 = CASE
          WHEN p.code = t.code THEN COALESCE(t.barcode2, p.barcode2)
          WHEN p.code = t.barcode2 THEN COALESCE(t.code, p.barcode2)
          WHEN p.barcode2 = t.code THEN COALESCE(t.barcode2, p.barcode2)
          WHEN p.barcode2 = t.barcode2 THEN t.code
          ELSE p.barcode2
        END
      FROM tmp_import t
      WHERE p.is_deleted = false AND (
        p.code = t.code OR p.code = t.barcode2
        OR (t.barcode2 IS NOT NULL AND p.barcode2 = t.code)
        OR (t.barcode2 IS NOT NULL AND p.barcode2 = t.barcode2)
      )`);
    console.log(`✓ อัปเดตสินค้าเดิม: ${upd.rowCount} รายการ`);

    // เพิ่มสินค้าใหม่ที่ยังไม่มีในระบบเลย
    const ins = await client.query(`
      INSERT INTO products (code, barcode2, name, unit, is_custom)
      SELECT DISTINCT t.code, t.barcode2, t.name, t.unit, false
      FROM tmp_import t
      WHERE NOT EXISTS (
        SELECT 1 FROM products p WHERE
          p.code = t.code OR p.code = t.barcode2
          OR (t.barcode2 IS NOT NULL AND p.barcode2 = t.code)
          OR (t.barcode2 IS NOT NULL AND p.barcode2 = t.barcode2)
      )`);
    console.log(`✓ เพิ่มสินค้าใหม่: ${ins.rowCount} รายการ`);
  } finally {
    client.release();
  }

  const total = (await db.get('SELECT COUNT(*) c FROM products WHERE is_deleted=false')).c;
  console.log(`\nเสร็จสิ้น — สินค้าทั้งหมดในระบบ ${total} รายการ`);
  await db.pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
