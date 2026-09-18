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

  // 검색 결과는 매번 실시간으로 긁어와서 우리 쪽 고정 캠핑장 ID가 없다 - 그래서 즐겨찾기는
  // "합쳐진 카드의 대표 링크(primary_link)"를 기준으로 저장하고, 그 카드에 딸린 모든 플랫폼
  // 링크는 links_json에 같이 넣어둔다. 검색 결과에 즐겨찾기 표시를 할 때 links_json에 든 링크
  // 중 하나라도 걸리면 같은 캠핑장으로 보고 별표를 켠다(다음 검색에선 플랫폼 조합이 달라질 수
  // 있어서 - 예: 이번엔 네이버가 안 잡힐 수도 있음).
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS favorites (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      primary_link TEXT NOT NULL,
      name TEXT,
      addr TEXT,
      price INTEGER,
      thumbnail TEXT,
      links_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, primary_link)
    );
  `);
}

module.exports = { getPool, ensureSchema };
