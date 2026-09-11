const form = document.getElementById('searchForm');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const mapViewEl = document.getElementById('mapView');
const mapToggleBtn = document.getElementById('mapToggleBtn');
const siteTypeInput = document.getElementById('siteTypeInput');
const filtersInput = document.getElementById('filtersInput');
const onlyAvailableInput = document.getElementById('onlyAvailableInput');

let filterTags = []; // /api/meta 응답 캐시 (그룹 라벨, 매칭용 텍스트 등)
let selectedSiteType = '';
const selectedFilters = new Set();
let onlyAvailable = false;
let mapMode = false;
let naverMapsClientId = null;
let naverMapsSdkPromise = null;
let naverMap = null;
let mapMarkers = [];

function fmtYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d;
}

const checkinInput = document.getElementById('checkin');
const checkoutInput = document.getElementById('checkout');
const defaultDateRange = [addDays(1), addDays(2)];

const datePicker = flatpickr('#dateRange', {
  mode: 'range',
  locale: 'ko',
  minDate: 'today',
  dateFormat: 'Y-m-d',
  defaultDate: defaultDateRange,
  showMonths: window.innerWidth < 480 ? 1 : 2,
  onChange(selectedDates) {
    if (selectedDates.length !== 2) return;
    checkinInput.value = fmtYmd(selectedDates[0]);
    checkoutInput.value = fmtYmd(selectedDates[1]);
  },
});
checkinInput.value = fmtYmd(defaultDateRange[0]);
checkoutInput.value = fmtYmd(defaultDateRange[1]);

function won(n) {
  return n == null ? '가격 정보 없음' : `${n.toLocaleString('ko-KR')}원~`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function loadMeta() {
  const res = await fetch('/api/meta');
  if (res.status === 401) return (window.location.href = '/login');
  const data = await res.json();
  filterTags = data.filterTags || [];
  naverMapsClientId = data.naverMapsClientId || null;
  renderSiteTypeChips(data.siteTypes || {});
  renderFilterGroups(filterTags);
  if (!naverMapsClientId) {
    mapToggleBtn.classList.add('disabled');
    mapToggleBtn.title = '네이버 지도 API 키가 아직 설정되지 않았어요';
  }
}

function loadNaverMapsSdk() {
  if (naverMapsSdkPromise) return naverMapsSdkPromise;
  naverMapsSdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(naverMapsClientId)}`;
    script.onload = resolve;
    script.onerror = () => reject(new Error('네이버 지도 스크립트를 불러오지 못했어요'));
    document.head.appendChild(script);
  });
  return naverMapsSdkPromise;
}

async function loadMe() {
  const res = await fetch('/api/me');
  if (res.status === 401) return (window.location.href = '/login');
  const data = await res.json();
  const badge = document.getElementById('userBadge');
  if (!data.email) return; // 로그인 기능이 꺼져있는 상태(ENABLE_AUTH=false) - 배지를 표시하지 않는다.
  badge.innerHTML = `<span>${esc(data.email)}</span><button type="button" id="logoutBtn">로그아웃</button>`;
  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
  });
}

function renderSiteTypeChips(siteTypes) {
  const container = document.getElementById('siteTypeChips');
  container.innerHTML = Object.entries(siteTypes).map(([value, label]) => (
    `<button type="button" class="chip${value === selectedSiteType ? ' active' : ''}" data-value="${esc(value)}">${esc(label)}</button>`
  )).join('');
  container.querySelectorAll('.chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedSiteType = btn.dataset.value;
      siteTypeInput.value = selectedSiteType;
      container.querySelectorAll('.chip').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });
}

function renderFilterGroups(tags) {
  const groups = [];
  const byName = new Map();
  tags.forEach((t) => {
    if (!byName.has(t.group)) {
      byName.set(t.group, []);
      groups.push(t.group);
    }
    byName.get(t.group).push(t);
  });

  const container = document.getElementById('filterGroups');
  container.innerHTML = groups.map((groupName) => `
    <div class="filter-section">
      <div class="filter-section-title">${esc(groupName)}</div>
      <div class="chip-row">
        ${groupName === '예약 옵션' ? '<button type="button" id="onlyAvailableChip" class="chip">예약 가능</button>' : ''}
        ${byName.get(groupName).map((t) => (
          `<button type="button" class="chip" data-key="${esc(t.key)}">${esc(t.label)}</button>`
        )).join('')}
      </div>
    </div>
  `).join('');

  container.querySelectorAll('.chip[data-key]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.key;
      if (selectedFilters.has(key)) selectedFilters.delete(key);
      else selectedFilters.add(key);
      btn.classList.toggle('active');
      filtersInput.value = [...selectedFilters].join(',');
    });
  });

  const availChip = document.getElementById('onlyAvailableChip');
  if (availChip) {
    availChip.addEventListener('click', () => {
      onlyAvailable = !onlyAvailable;
      availChip.classList.toggle('active', onlyAvailable);
      onlyAvailableInput.value = onlyAvailable ? 'true' : '';
    });
  }
}

function resetFilters() {
  form.reset();
  datePicker.setDate(defaultDateRange, true); // true = onChange 트리거 -> hidden input도 같이 갱신
  selectedSiteType = '';
  selectedFilters.clear();
  onlyAvailable = false;
  siteTypeInput.value = '';
  filtersInput.value = '';
  onlyAvailableInput.value = '';
  document.querySelectorAll('#siteTypeChips .chip').forEach((b, i) => b.classList.toggle('active', i === 0 && b.dataset.value === ''));
  document.querySelectorAll('#filterGroups .chip').forEach((b) => b.classList.remove('active'));
}

document.getElementById('resetBtn').addEventListener('click', () => {
  resetFilters();
  form.dispatchEvent(new Event('submit'));
});

function availabilityHtml(item) {
  if (item.totalSites == null || item.availableSites == null) {
    return '<span class="avail">잔여석 정보 없음</span>';
  }
  const ok = item.availableSites > 0;
  return `<span class="avail ${ok ? 'ok' : 'none'}">${ok ? `잔여 ${item.availableSites}/${item.totalSites}` : '예약 마감'}</span>`;
}

function cardHtml(item) {
  // 지금 선택된 필터에 해당하는 편의시설은 검색 이유가 되는 경우가 많아 앞으로 정렬해 잘리지 않게 한다.
  const activeMatches = filterTags
    .filter((t) => selectedFilters.has(t.key))
    .flatMap((t) => t.match);
  const isPriority = (a) => activeMatches.some((m) => a.includes(m));
  const list = [...(item.amenities || [])].sort((a, b) => Number(isPriority(b)) - Number(isPriority(a)));
  const shown = list.slice(0, 5).map((a) => `<span>${esc(a)}</span>`).join('');
  const more = list.length > 5 ? `<span class="more">+${list.length - 5}</span>` : '';
  const amenities = shown + more;
  const img = item.thumbnail
    ? `<img src="${esc(item.thumbnail)}" alt="${esc(item.name)}" loading="lazy" />`
    : '';
  return `
    <div class="card" data-link="${esc(item.link)}">
      ${img}
      <div class="card-body">
        <span class="platform-tag ${esc(item.platform)}">${esc(item.platform)}</span>
        <h3>${esc(item.name)}</h3>
        <div class="addr">${esc(item.addr || '')}</div>
        <div class="price">${won(item.price)}</div>
        ${availabilityHtml(item)}
        <div class="amenities">${amenities}</div>
        <a class="link" href="${esc(item.link)}" target="_blank" rel="noopener">사이트에서 보기 →</a>
      </div>
    </div>
  `;
}

async function renderMap(items) {
  await loadNaverMapsSdk();
  if (!naverMap) {
    naverMap = new naver.maps.Map(mapViewEl, {
      center: new naver.maps.LatLng(36.5, 127.8),
      zoom: 7,
    });
  }
  mapMarkers.forEach((m) => m.setMap(null));
  mapMarkers = [];

  const withCoords = items.filter((i) => i.lat != null && i.lng != null);
  const bounds = new naver.maps.LatLngBounds();
  withCoords.forEach((item) => {
    const position = new naver.maps.LatLng(item.lat, item.lng);
    const marker = new naver.maps.Marker({
      position,
      map: naverMap,
      icon: {
        content: `<div class="map-price-marker platform-${esc(item.platform)}">▲ ${won(item.price)}</div>`,
        anchor: new naver.maps.Point(30, 34),
      },
    });
    naver.maps.Event.addListener(marker, 'click', () => {
      setMapMode(false);
      const card = resultsEl.querySelector(`[data-link="${CSS.escape(item.link)}"]`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    mapMarkers.push(marker);
    bounds.extend(position);
  });
  if (withCoords.length) naverMap.fitBounds(bounds);
}

function setMapMode(on) {
  if (on && !naverMapsClientId) {
    statusEl.className = 'error';
    statusEl.textContent = '네이버 지도 API 키가 아직 설정되지 않아 지도를 켤 수 없어요.';
    return false;
  }
  mapMode = on;
  mapToggleBtn.classList.toggle('active', mapMode);
  mapViewEl.hidden = !mapMode;
  resultsEl.hidden = mapMode;
  return true;
}

mapToggleBtn.addEventListener('click', () => {
  const wasMap = mapMode;
  if (!setMapMode(!mapMode)) return;
  if (!wasMap) form.dispatchEvent(new Event('submit')); // 지도를 새로 켤 때만 좌표 포함해서 다시 검색
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const params = new URLSearchParams(new FormData(form));
  if (mapMode) params.set('map', 'true');
  statusEl.className = '';
  statusEl.textContent = '검색 중... (캠핏은 브라우저를 여는 방식이라 몇 초 더 걸릴 수 있어요)';
  resultsEl.innerHTML = '';

  try {
    const res = await fetch('/api/search?' + params.toString());
    if (res.status === 401) return (window.location.href = '/login');
    const data = await res.json();

    let statusText = `총 ${data.count}건`;
    if (data.notices && data.notices.length) {
      statusText += ' · ' + data.notices.join(' ');
    }
    if (data.errors && data.errors.length) {
      statusText += ' · 오류: ' + data.errors.map((e) => `${e.platform}(${e.message})`).join(', ');
      statusEl.className = 'error';
    }
    statusEl.textContent = statusText;

    resultsEl.innerHTML = data.items.map(cardHtml).join('') || '<p>검색 결과가 없습니다.</p>';

    if (mapMode) {
      try {
        await renderMap(data.items);
      } catch (mapErr) {
        statusEl.className = 'error';
        statusEl.textContent = statusText + ' · 지도 로드 실패: ' + mapErr.message;
      }
    }
  } catch (err) {
    statusEl.className = 'error';
    statusEl.textContent = '검색 실패: ' + err.message;
  }
});

loadMe();
loadMeta();
form.dispatchEvent(new Event('submit'));
