const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function won(n) {
  return n == null ? '가격 정보 없음' : `${n.toLocaleString('ko-KR')}원~`;
}

async function loadMe() {
  const res = await fetch('/api/me');
  if (res.status === 401) return (window.location.href = '/login');
  const data = await res.json();
  const badge = document.getElementById('userBadge');
  if (!data.email) return;
  badge.innerHTML = `<span>${esc(data.email)}</span><button type="button" id="logoutBtn">로그아웃</button>`;
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  });
}

function platformTagsHtml(fav) {
  const platforms = fav.links && fav.links.length ? fav.links.map((l) => l.platform).filter(Boolean) : [];
  return platforms.map((p) => `<span class="platform-tag ${esc(p)}">${esc(p)}</span>`).join('');
}

function platformLinksHtml(fav) {
  const links = fav.links && fav.links.length ? fav.links : [{ platform: null, link: fav.link, price: fav.price }];
  if (links.length === 1) {
    return `<a class="link" href="${esc(links[0].link)}" target="_blank" rel="noopener">사이트에서 보기 →</a>`;
  }
  return `
    <div class="platform-links">
      ${links.map((l) => (
        `<a class="platform-link-btn platform-${esc(l.platform)}" href="${esc(l.link)}" target="_blank" rel="noopener">${esc(l.platform)}${l.price != null ? ` ${l.price.toLocaleString('ko-KR')}원~` : ''}</a>`
      )).join('')}
    </div>
  `;
}

function favCardHtml(fav) {
  const img = fav.thumbnail
    ? `<img src="${esc(fav.thumbnail)}" alt="${esc(fav.name)}" loading="lazy" />`
    : '';
  return `
    <div class="card" data-link="${esc(fav.link)}">
      <button type="button" class="fav-btn active" data-fav-link="${esc(fav.link)}" title="즐겨찾기 해제">★</button>
      ${img}
      <div class="card-body">
        <div class="platform-tags">${platformTagsHtml(fav)}</div>
        <h3>${esc(fav.name || '이름 정보 없음')}</h3>
        <div class="addr">${esc(fav.addr || '')}</div>
        <div class="price">${won(fav.price)}</div>
        ${platformLinksHtml(fav)}
      </div>
    </div>
  `;
}

async function removeFavorite(link) {
  await fetch('/api/favorites', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link }),
  });
  const card = resultsEl.querySelector(`[data-link="${CSS.escape(link)}"]`);
  if (card) card.remove();
  const remaining = resultsEl.querySelectorAll('.card').length;
  statusEl.textContent = `총 ${remaining}건`;
  if (!remaining) {
    resultsEl.innerHTML = '<p>아직 즐겨찾기한 캠핑장이 없어요. 검색 결과 카드의 ☆ 버튼을 눌러 추가해보세요.</p>';
  }
}

resultsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.fav-btn');
  if (!btn) return;
  removeFavorite(btn.dataset.favLink);
});

async function loadFavorites() {
  statusEl.textContent = '불러오는 중...';
  try {
    const res = await fetch('/api/favorites');
    if (res.status === 401) return (window.location.href = '/login');
    const data = await res.json();
    const items = data.items || [];
    statusEl.textContent = `총 ${items.length}건`;
    resultsEl.innerHTML = items.map(favCardHtml).join('')
      || '<p>아직 즐겨찾기한 캠핑장이 없어요. 검색 결과 카드의 ☆ 버튼을 눌러 추가해보세요.</p>';
  } catch (err) {
    statusEl.className = 'error';
    statusEl.textContent = '불러오기 실패: ' + err.message;
  }
}

loadMe();
loadFavorites();
