const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
}

function readAll() {
  ensureFile();
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

// 동시에 여러 요청이 파일을 쓰면 덮어써질 수 있어, 쓰기 작업을 하나의 프로미스 체인으로 직렬화한다.
let writeQueue = Promise.resolve();
function writeAll(users) {
  writeQueue = writeQueue.then(() => fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)));
  return writeQueue;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function findByEmail(email) {
  const users = readAll();
  return users.find((u) => u.email === normalizeEmail(email)) || null;
}

async function createUser(email, passwordHash) {
  const users = readAll();
  const normalized = normalizeEmail(email);
  if (users.some((u) => u.email === normalized)) {
    throw new Error('이미 가입된 이메일입니다.');
  }
  const user = {
    id: crypto.randomUUID(),
    email: normalized,
    passwordHash,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  await writeAll(users);
  return user;
}

module.exports = { findByEmail, createUser, normalizeEmail };
