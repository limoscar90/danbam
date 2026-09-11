const { Pool } = require('pg');

// 인증이 꺼져있는 로컬 프리뷰(ENABLE_AUTH=false)에서는 이 모듈이 아예 쓰이지 않아야 하므로,
// require 시점이 아니라 실제로 커넥션이 필요한 시점에 DATABASE_URL을 확인한다.
let pool = null;
function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL이 설정되어 있지 않습니다 (.env 또는 배포 환경 변수를 확인하세요).');
    }
    // Supabase는 기본적으로 SSL 연결을 요구하지만, 로컬 개발용 자체 서명 인증서 체인 검증까지는
    // 필요 없어서 rejectUnauthorized는 꺼둔다.
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function ensureSchema() {
  // id는 Node의 crypto.randomUUID()로 채워서 넣는다 - pgcrypto 확장 활성화 여부에 기대지 않기 위해.
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

module.exports = { getPool, ensureSchema };
