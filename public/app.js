const form = document.getElementById('searchForm');
const statusEl = document.getElementById('status');
const resultsEl = document.getElementById('results');
const mapViewWrapEl = document.getElementById('mapViewWrap');
const mapViewEl = document.getElementById('mapView');
const mapCarouselEl = document.getElementById('mapCarousel');
const searchAreaBtnEl = document.getElementById('searchAreaBtn');
const listViewBtn = document.getElementById('listViewBtn');
const mapViewBtn = document.getElementById('mapViewBtn');
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
let mapMarkers = []; // { marker, link }[]
let allMapItems = []; // 현재 검색 결과 중 좌표가 있는 전체 목록 - "이 지역에서 검색" 필터링용
let suppressMapEvents = false; // fitBounds/panTo 같은 코드로 인한 이동은 "지도 움직임"으로 안 치게 막는 플래그

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
    mapViewBtn.classList.add('disabled');
    mapViewBtn.title = '네이버 지도 API 키가 아직 설정되지 않았어요';
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

function carouselCardHtml(item) {
  const img = item.thumbnail
    ? `<img src="${esc(item.thumbnail)}" alt="${esc(item.name)}" loading="lazy" />`
    : '';
  return `
    <div class="carousel-card" data-link="${esc(item.link)}">
      ${img}
      <div class="carousel-card-body">
        <span class="platform-tag ${esc(item.platform)}">${esc(item.platform)}</span>
        <h4>${esc(item.name)}</h4>
        <div class="addr">${esc(item.addr || '')}</div>
        <div class="price">${won(item.price)}</div>
        <a class="link" href="${esc(item.link)}" target="_blank" rel="noopener">사이트에서 보기 →</a>
      </div>
    </div>
  `;
}

// 지도 마커 <-> 아래 캐러셀 카드를 서로 하이라이트해서 어떤 게 어떤 건지 바로 알 수 있게 한다.
function highlightCarouselCard(link) {
  mapCarouselEl.querySelectorAll('.carousel-card').forEach((el) => {
    el.classList.toggle('highlight', el.dataset.link === link);
  });
  const card = mapCarouselEl.querySelector(`[data-link="${CSS.escape(link)}"]`);
  if (card) {
    // scrollIntoView는 세로 방향도 같이 건드려서 페이지가 아래로 내려갔다 올라오는 문제가 있었다.
    // 캐러셀 자신의 scrollLeft만 옮겨서 지도가 보이는 위치는 그대로 유지한다.
    const target = card.offsetLeft - (mapCarouselEl.clientWidth - card.clientWidth) / 2;
    mapCarouselEl.scrollTo({ left: target, behavior: 'smooth' });
  }
}

// fitBounds/panTo처럼 코드가 지도를 움직이는 동안엔 dragend/zoom_changed를 사용자 조작으로 착각하지 않게 막는다.
function moveMapSilently(fn) {
  suppressMapEvents = true;
  fn();
  setTimeout(() => { suppressMapEvents = false; }, 300);
}

function renderMarkersAndCarousel(items) {
  mapMarkers.forEach((m) => m.marker.setMap(null));
  mapMarkers = [];

  mapCarouselEl.innerHTML = items.map(carouselCardHtml).join('')
    || '<p class="carousel-empty">지도에 표시할 캠핑장이 없어요.</p>';
  mapCarouselEl.querySelectorAll('.carousel-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('a')) return; // "사이트에서 보기" 링크 클릭은 지도 이동을 트리거하지 않는다.
      const link = card.dataset.link;
      highlightCarouselCard(link);
      const found = mapMarkers.find((m) => m.link === link);
      if (found) {
        moveMapSilently(() => naverMap.panTo(found.marker.getPosition()));
        highlightMarker(link);
      }
    });
  });

  items.forEach((item) => {
    const position = new naver.maps.LatLng(item.lat, item.lng);
    const marker = new naver.maps.Marker({
      position,
      map: naverMap,
      icon: {
        content: `<div class="map-price-marker platform-${esc(item.platform)}" data-link="${esc(item.link)}">▲ ${won(item.price)}</div>`,
        anchor: new naver.maps.Point(30, 34),
      },
    });
    naver.maps.Event.addListener(marker, 'click', () => {
      highlightCarouselCard(item.link);
      highlightMarker(item.link);
    });
    mapMarkers.push({ marker, link: item.link });
  });
}

async function renderMap(items) {
  await loadNaverMapsSdk();
  if (!naverMap) {
    naverMap = new naver.maps.Map(mapViewEl, {
      center: new naver.maps.LatLng(36.5, 127.8),
      zoom: 7,
    });
    // 사용자가 직접 드래그/줌했을 때만 "이 지역에서 검색" 버튼을 보여준다(우리 코드가 움직인 건 제외).
    naver.maps.Event.addListener(naverMap, 'dragend', () => {
      if (!suppressMapEvents) searchAreaBtnEl.hidden = false;
    });
    naver.maps.Event.addListener(naverMap, 'zoom_changed', () => {
      if (!suppressMapEvents) searchAreaBtnEl.hidden = false;
    });
  }

  const withCoords = items.filter((i) => i.lat != null && i.lng != null);
  allMapItems = withCoords;
  renderMarkersAndCarousel(withCoords);

  const bounds = new naver.maps.LatLngBounds();
  withCoords.forEach((item) => bounds.extend(new naver.maps.LatLng(item.lat, item.lng)));
  if (withCoords.length) moveMapSilently(() => naverMap.fitBounds(bounds));
  searchAreaBtnEl.hidden = true;
}

function searchThisArea() {
  const bounds = naverMap.getBounds();
  const visible = allMapItems.filter((i) => bounds.hasLatLng(new naver.maps.LatLng(i.lat, i.lng)));
  renderMarkersAndCarousel(visible);
  statusEl.className = '';
  statusEl.textContent = `현재 지도 범위 내 ${visible.length}건`;
  searchAreaBtnEl.hidden = true;
}

searchAreaBtnEl.addEventListener('click', searchThisArea);

function highlightMarker(link) {
  // 마커는 HTML 오버레이라 SDK 객체가 아니라 DOM에서 직접 찾아 하이라이트한다.
  mapViewEl.querySelectorAll('.map-price-marker').forEach((el) => {
    el.classList.toggle('active', el.dataset.link === link);
  });
}

function setViewMode(mode) {
  if (mode === 'map' && !naverMapsClientId) {
    statusEl.className = 'error';
    statusEl.textContent = '네이버 지도 API 키가 아직 설정되지 않아 지도를 켤 수 없어요.';
    return false;
  }
  const wasMap = mapMode;
  mapMode = mode === 'map';
  listViewBtn.classList.toggle('active', !mapMode);
  mapViewBtn.classList.toggle('active', mapMode);
  mapViewWrapEl.hidden = !mapMode;
  mapCarouselEl.hidden = !mapMode;
  resultsEl.hidden = mapMode;
  if (!mapMode) searchAreaBtnEl.hidden = true;
  // 지도로 처음 전환할 때만 좌표를 포함해서 다시 검색한다(리스트<->지도 왕복은 재검색 없이 캐시된 결과로 전환).
  if (mapMode && !wasMap) form.dispatchEvent(new Event('submit'));
  return true;
}

listViewBtn.addEventListener('click', () => setViewMode('list'));
mapViewBtn.addEventListener('click', () => setViewMode('map'));

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
