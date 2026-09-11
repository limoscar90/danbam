const crypto = require('crypto');
const { getPool } = require('./db');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function findByEmail(email) {
  const normalized = normalizeEmail(email);
  const { rows } = await getPool().query(
    'SELECT id, email, password_hash AS "passwordHash" FROM users WHERE email = $1',
    [normalized]
  );
  return rows[0] || null;
}

async function createUser(email, passwordHash) {
  const normalized = normalizeEmail(email);
  const existing = await findByEmail(normalized);
  if (existing) throw new Error('이미 가입된 이메일입니다.');

  const id = crypto.randomUUID();
  await getPool().query(
    'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
    [id, normalized, passwordHash]
  );
  return { id, email: normalized, passwordHash };
}

module.exports = { findByEmail, createUser, normalizeEmail };
