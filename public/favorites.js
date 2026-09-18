const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const checkinInput = { value: '' };
const checkoutInput = { value: '' };

let lastFavorites = [];
let availabilityByLink = {}; // link -> { price, totalSites, availableSites }
let hasDates = false;

function fmtYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const datePicker = flatpickr('#dateRange', {
  mode: 'range',
  locale: 'ko',
  minDate: 'today',
  dateFormat: 'Y-m-d',
  showMonths: window.innerWidth < 480 ? 1 : 2,
  onChange(selectedDates) {
    if (selectedDates.length !== 2) {
      checkinInput.value = '';
      checkoutInput.value = '';
      hasDates = false;
      availabilityByLink = {};
      render();
      return;
    }
    checkinInput.value = fmtYmd(selectedDates[0]);
    checkoutInput.value = fmtYmd(selectedDates[1]);
    hasDates = true;
    loadAvailability();
  },
});

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

// 즐겨찾기엔 저장 당시 가격만 있어서, 날짜를 고르면 그 날짜 기준 실시간 가격/잔여석으로 바꿔 보여준다.
function availLabel(link) {
  const a = availabilityByLink[link];
  if (!a) return hasDates ? ' · 이 날짜엔 확인 안 됨' : '';
  if (a.totalSites == null || a.availableSites == null) return '';
  return a.availableSites > 0 ? ` · 잔여 ${a.availableSites}/${a.totalSites}` : ' · 예약 마감';
}

function livePrice(l) {
  const a = availabilityByLink[l.link];
  return (a && a.price != null) ? a.price : l.price;
}

function platformLinksHtml(fav) {
  const links = fav.links && fav.links.length ? fav.links : [{ platform: null, link: fav.link, price: fav.price }];
  if (links.length === 1) {
    return `<a class="link" href="${esc(links[0].link)}" target="_blank" rel="noopener">사이트에서 보기 →${esc(availLabel(links[0].link))}</a>`;
  }
  return `
    <div class="platform-links">
      ${links.map((l) => {
        const price = livePrice(l);
        return `<a class="platform-link-btn platform-${esc(l.platform)}" href="${esc(l.link)}" target="_blank" rel="noopener">${esc(l.platform)}${price != null ? ` ${price.toLocaleString('ko-KR')}원~` : ''}${esc(availLabel(l.link))}</a>`;
      }).join('')}
    </div>
  `;
}

function favPrice(fav) {
  const links = fav.links && fav.links.length ? fav.links : [{ link: fav.link, price: fav.price }];
  const prices = links.map(livePrice).filter((p) => p != null);
  return prices.length ? Math.min(...prices) : fav.price;
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
        <div class="price">${won(favPrice(fav))}</div>
        ${platformLinksHtml(fav)}
      </div>
    </div>
  `;
}

function render() {
  resultsEl.innerHTML = lastFavorites.map(favCardHtml).join('')
    || '<p>아직 즐겨찾기한 캠핑장이 없어요. 검색 결과 카드의 ☆ 버튼을 눌러 추가해보세요.</p>';
}

async function loadAvailability() {
  if (!lastFavorites.length) return;
  statusEl.textContent = `총 ${lastFavorites.length}건 · 빈자리 확인 중...`;
  try {
    const res = await fetch('/api/favorites/availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkin: checkinInput.value, checkout: checkoutInput.value }),
    });
    if (res.status === 401) return (window.location.href = '/login');
    const data = await res.json();
    availabilityByLink = {};
    (data.items || []).forEach((item) => {
      (item.byPlatform || []).forEach((p) => { availabilityByLink[p.link] = p; });
    });
    statusEl.textContent = `총 ${lastFavorites.length}건 · ${checkinInput.value} ~ ${checkoutInput.value} 기준 빈자리`;
  } catch (err) {
    statusEl.className = 'error';
    statusEl.textContent = '빈자리 확인 실패: ' + err.message;
  }
  render();
}

async function removeFavorite(link) {
  await fetch('/api/favorites', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link }),
  });
  lastFavorites = lastFavorites.filter((f) => f.link !== link);
  statusEl.textContent = `총 ${lastFavorites.length}건`;
  render();
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
    lastFavorites = data.items || [];
    statusEl.textContent = `총 ${lastFavorites.length}건`;
    render();
  } catch (err) {
    statusEl.className = 'error';
    statusEl.textContent = '불러오기 실패: ' + err.message;
  }
}

loadMe();
loadFavorites();
