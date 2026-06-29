// src/db.js — เชื่อมต่อ Postgres (Supabase) + สคีมา
if (!process.env.DATABASE_URL) {
  try { require('dotenv').config(); } catch (_) { /* dotenv ไม่จำเป็นต้องมีบน production */ }
}

const { Pool } = require('pg');

// แยก parse เอง (ไม่ใช้ connectionString ตรงๆ) เพราะ username ของ Supabase pooler
// มีจุด (เช่น postgres.xxxx) ซึ่งบางเวอร์ชันของ pg parse ผิดพลาดได้
function parseConnString(url) {
  const u = new URL(url);
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    host: u.hostname,
    port: +u.port || 5432,
    database: u.pathname.replace(/^\//, '') || 'postgres',
  };
}

const dbUrl = process.env.DATABASE_URL;
const pool = new Pool({
  ...(dbUrl ? parseConnString(dbUrl) : {}),
  ssl: dbUrl && dbUrl.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function all(text, params = []) {
  const res = await pool.query(text, params);
  return res.rows;
}
async function get(text, params = []) {
  const rows = await all(text, params);
  return rows[0];
}
async function run(text, params = []) {
  const res = await pool.query(text, params);
  return { rowCount: res.rowCount, rows: res.rows };
}
// รันหลายคำสั่งใน transaction เดียว — fn รับ client ที่มี .all/.get/.run แบบเดียวกัน
async function withTransaction(fn) {
  const client = await pool.connect();
  const scoped = {
    all: async (text, params = []) => (await client.query(text, params)).rows,
    get: async (text, params = []) => (await client.query(text, params)).rows[0],
    run: async (text, params = []) => {
      const res = await client.query(text, params);
      return { rowCount: res.rowCount, rows: res.rows };
    },
  };
  try {
    await client.query('BEGIN');
    const result = await fn(scoped);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function init() {
  await pool.query(`
  -- ผู้ใช้ระบบ (พนักงาน)
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL,
    role          TEXT NOT NULL CHECK(role IN ('intern','angel','guardian','god')),
    active        BOOLEAN NOT NULL DEFAULT true,
    approved      BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  -- เผื่อตารางถูกสร้างไว้ก่อนหน้า (ก่อนมีฟีเจอร์สมัครสมาชิก) — เพิ่มคอลัมน์ย้อนหลังแบบไม่กระทบผู้ใช้เดิม
  ALTER TABLE users ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT true;

  -- session เข้าสู่ระบบ (เก็บใน DB เพื่อให้ใช้ได้บน serverless หลาย instance)
  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- ช่องเก็บสินค้าในโกดัง
  CREATE TABLE IF NOT EXISTS cells (
    code  TEXT PRIMARY KEY,
    zone  TEXT NOT NULL
  );

  -- สินค้า (code = บาร์โค้ด หรือรหัสที่พนักงานกำหนดเอง, ห้ามซ้ำ)
  CREATE TABLE IF NOT EXISTS products (
    id          SERIAL PRIMARY KEY,
    code        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    unit        TEXT,
    image_url   TEXT,
    is_custom   BOOLEAN NOT NULL DEFAULT false,
    is_deleted  BOOLEAN NOT NULL DEFAULT false,
    created_by  INTEGER REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
  -- บาร์โค้ดสำรอง (สินค้าบางตัวมี 2 บาร์โค้ด) — ค้นหา/สแกนแล้วหาไม่เจอจากรหัสหลักให้ลองอันนี้
  ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode2 TEXT;
  CREATE INDEX IF NOT EXISTS idx_products_barcode2 ON products(barcode2);

  -- ยอดคงเหลือต่อช่อง (หลายต่อหลาย: หนึ่งช่องหลายสินค้า, หนึ่งสินค้าหลายช่อง)
  -- variant = ตัวเลือกย่อยของสินค้า เช่น สี/ไซส์ ('' = ไม่มีตัวเลือกย่อย เพื่อให้ของเดิมทำงานเหมือนเดิม)
  CREATE TABLE IF NOT EXISTS stock_by_cell (
    product_id  INTEGER NOT NULL REFERENCES products(id),
    cell_code   TEXT NOT NULL REFERENCES cells(code),
    qty         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, cell_code)
  );
  ALTER TABLE stock_by_cell ADD COLUMN IF NOT EXISTS variant TEXT NOT NULL DEFAULT '';
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_by_cell_pkey') THEN
      ALTER TABLE stock_by_cell DROP CONSTRAINT stock_by_cell_pkey;
      ALTER TABLE stock_by_cell ADD PRIMARY KEY (product_id, cell_code, variant);
    END IF;
  END $$;

  -- รายการเคลื่อนไหว (ทุกแถวผ่านกฎสองมือ: คนทำ + คนยืนยัน คนละคน)
  CREATE TABLE IF NOT EXISTS movements (
    id            SERIAL PRIMARY KEY,
    type          TEXT NOT NULL CHECK(type IN ('import','withdraw','move','initial')),
    product_id    INTEGER NOT NULL REFERENCES products(id),
    qty           INTEGER NOT NULL CHECK(qty > 0),
    from_cell     TEXT REFERENCES cells(code),
    to_cell       TEXT REFERENCES cells(code),
    note          TEXT,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','cancelled')),
    created_by    INTEGER NOT NULL REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_by  INTEGER REFERENCES users(id),
    confirmed_at  TIMESTAMPTZ,
    cancelled_by  INTEGER REFERENCES users(id),
    cancelled_at  TIMESTAMPTZ,
    cancel_reason TEXT
  );
  ALTER TABLE movements ADD COLUMN IF NOT EXISTS variant TEXT NOT NULL DEFAULT '';
  CREATE INDEX IF NOT EXISTS idx_mv_status ON movements(status);
  CREATE INDEX IF NOT EXISTS idx_mv_product ON movements(product_id);
  CREATE INDEX IF NOT EXISTS idx_mv_creator ON movements(created_by);

  -- ประวัติการแก้ไขรายการที่ยืนยันแล้ว (เก็บค่าเก่า ไม่ลบทิ้ง)
  CREATE TABLE IF NOT EXISTS edit_history (
    id            SERIAL PRIMARY KEY,
    movement_id   INTEGER NOT NULL REFERENCES movements(id),
    field         TEXT NOT NULL,
    old_value     TEXT,
    new_value     TEXT,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed')),
    requested_by  INTEGER NOT NULL REFERENCES users(id),
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_by  INTEGER REFERENCES users(id),
    confirmed_at  TIMESTAMPTZ
  );
  `);
}

module.exports = { pool, all, get, run, withTransaction, init };
