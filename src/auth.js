// src/auth.js — แฮชรหัสผ่าน (scrypt) + session ใน Postgres
const crypto = require('crypto');
const db = require('./db');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await db.run('INSERT INTO sessions (token, user_id) VALUES ($1, $2)', [token, userId]);
  return token;
}
async function getSession(token) {
  if (!token) return null;
  const row = await db.get('SELECT user_id AS "userId" FROM sessions WHERE token=$1', [token]);
  return row || null;
}
async function destroySession(token) {
  if (!token) return;
  await db.run('DELETE FROM sessions WHERE token=$1', [token]);
}

module.exports = { hashPassword, verifyPassword, createSession, getSession, destroySession };
