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
const platformsInput = document.getElementById('platformsInput');

let filterTags = []; // /api/meta 응답 캐시 (그룹 라벨, 매칭용 텍스트 등)
let selectedSiteType = '';
const selectedFilters = new Set();
const selectedPlatforms = new Set();
let onlyAvailable = false;
let mapMode = false;
let naverMapsClientId = null;
let naverMapsSdkPromise = null;
let naverMap = null;
let mapMarkers = []; // { marker, link }[]
let allMapItems = []; // 현재 검색 결과 중 좌표가 있는 전체 목록 - "이 지역에서 검색" 필터링용
let suppressMapEvents = false; // fitBounds/panTo 같은 코드로 인한 이동은 "지도 움직임"으로 안 치게 막는 플래그
let lastSearchHadDates = false; // 가장 최근 검색에 체크인/체크아웃이 포함됐는지 - 잔여석 표시 여부 판단용
let favoriteLinks = new Set(); // 즐겨찾기에 저장된 모든 플랫폼 링크(합쳐진 카드는 여러 개) - 별표 상태 판단용
let lastListItems = []; // 가장 최근 검색 결과(리스트 모드) - 즐겨찾기 토글 후 재검색 없이 다시 그리는 용도
let itemsByLink = new Map(); // item.link -> item, 즐겨찾기 버튼 클릭 시 전체 데이터를 다시 찾기 위함

function fmtYmd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const checkinInput = document.getElementById('checkin');
const checkoutInput = document.getElementById('checkout');

// 날짜는 선택하지 않아도 검색이 되게(먼저 캠핑장을 둘러보고 나중에 날짜를 골라 빈자리를 확인하고
// 싶다는 요청) 처음엔 비워둔다 - defaultDate를 안 주면 필드가 빈 채로 시작한다.
const datePicker = flatpickr('#dateRange', {
  mode: 'range',
  locale: 'ko',
  minDate: 'today',
  dateFormat: 'Y-m-d',
  showMonths: window.innerWidth < 480 ? 1 : 2,
  // static: true로 입력창 바로 아래(부모 요소 기준)에 달력을 넣는다 - 안 그러면 document.body에
  // 붙어서 좌표를 직접 계산하는데, 본문을 가운데 정렬(max-width+margin:auto)한 뒤로 그 계산이
  // 어긋나 달력이 화면 가장자리에 엉뚱하게 뜨는 문제가 있었다.
  static: true,
  onChange(selectedDates) {
    if (selectedDates.length !== 2) {
      checkinInput.value = '';
      checkoutInput.value = '';
      return;
    }
    checkinInput.value = fmtYmd(selectedDates[0]);
    checkoutInput.value = fmtYmd(selectedDates[1]);
  },
});

function won(n) {
  return n == null ? '가격 정보 없음' : `${n.toLocaleString('ko-KR')}원~`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 로그인할 때마다 숙소유형/예약옵션/시설 같은 필터 칩을 매번 다시 고르지 않아도 되게, 마지막으로
// 쓴 조합을 계정에 저장해뒀다가 다음 로그인에 그대로 불러온다(지역/날짜/숙소명은 매번 달라지는
// 값이라 대상에서 뺐다).
function currentPrefs() {
  return {
    siteType: selectedSiteType,
    filters: [...selectedFilters],
    platforms: [...selectedPlatforms],
    onlyAvailable,
  };
}

function saveSearchPrefs() {
  fetch('/api/search-prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefs: currentPrefs() }),
  }).catch(() => {});
}

async function loadSearchPrefs() {
  try {
    const res = await fetch('/api/search-prefs');
    if (!res.ok) return;
    const data = await res.json();
    const prefs = data.prefs;
    if (!prefs) return;
    selectedSiteType = prefs.siteType || '';
    siteTypeInput.value = selectedSiteType;
    selectedFilters.clear();
    (prefs.filters || []).forEach((k) => selectedFilters.add(k));
    filtersInput.value = [...selectedFilters].join(',');
    selectedPlatforms.clear();
    (prefs.platforms || []).forEach((p) => selectedPlatforms.add(p));
    platformsInput.value = [...selectedPlatforms].join(',');
    onlyAvailable = Boolean(prefs.onlyAvailable);
    onlyAvailableInput.value = onlyAvailable ? 'true' : '';
  } catch (e) { /* 저장된 선호가 없거나 못 불러와도 기본값으로 계속 진행 */ }
}

function syncPlatformChipUI() {
  document.querySelectorAll('#platformChips .chip').forEach((b) => {
    b.classList.toggle('active', b.dataset.platform ? selectedPlatforms.has(b.dataset.platform) : selectedPlatforms.size === 0);
  });
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
  // 게스트는 서버가 만든 임의 이메일(guest-uuid@danbam.guest)을 그대로 보여주면 의미가 없어 대신
  // 회원가입을 안내한다.
  badge.innerHTML = data.isGuest
    ? '<span>게스트로 체험 중</span><a href="/signup" class="guest-signup-link">회원가입</a><button type="button" id="logoutBtn">로그아웃</button>'
    : `<span>${esc(data.email)}</span><button type="button" id="logoutBtn">로그아웃</button>`;
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
      saveSearchPrefs();
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
        ${groupName === '예약 옵션' ? `<button type="button" id="onlyAvailableChip" class="chip${onlyAvailable ? ' active' : ''}">예약 가능</button>` : ''}
        ${byName.get(groupName).map((t) => (
          `<button type="button" class="chip${selectedFilters.has(t.key) ? ' active' : ''}" data-key="${esc(t.key)}">${esc(t.label)}</button>`
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
      saveSearchPrefs();
    });
  });

  const availChip = document.getElementById('onlyAvailableChip');
  if (availChip) {
    availChip.addEventListener('click', () => {
      onlyAvailable = !onlyAvailable;
      availChip.classList.toggle('active', onlyAvailable);
      onlyAvailableInput.value = onlyAvailable ? 'true' : '';
      saveSearchPrefs();
    });
  }
}

// "전체"(기본)는 세 플랫폼 다 검색, 특정 플랫폼을 고르면 그것만 검색한다(느린 플랫폼을 빼면 더 빨라짐).
// "전체"를 누르면 개별 선택을 지우고, 개별 플랫폼을 하나라도 고르면 "전체"는 자동으로 꺼진다.
document.querySelectorAll('#platformChips .chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    const platform = btn.dataset.platform;
    if (!platform) {
      selectedPlatforms.clear();
    } else {
      if (selectedPlatforms.has(platform)) selectedPlatforms.delete(platform);
      else selectedPlatforms.add(platform);
    }
    platformsInput.value = [...selectedPlatforms].join(',');
    syncPlatformChipUI();
    saveSearchPrefs();
  });
});

function resetFilters() {
  form.reset();
  datePicker.clear();
  checkinInput.value = '';
  checkoutInput.value = '';
  selectedSiteType = '';
  selectedFilters.clear();
  selectedPlatforms.clear();
  onlyAvailable = false;
  siteTypeInput.value = '';
  filtersInput.value = '';
  onlyAvailableInput.value = '';
  platformsInput.value = '';
  document.querySelectorAll('#siteTypeChips .chip').forEach((b, i) => b.classList.toggle('active', i === 0 && b.dataset.value === ''));
  syncPlatformChipUI();
  document.querySelectorAll('#filterGroups .chip').forEach((b) => b.classList.remove('active'));
  saveSearchPrefs();
}

document.getElementById('resetBtn').addEventListener('click', () => {
  resetFilters();
  form.dispatchEvent(new Event('submit'));
});

function availabilityHtml(item) {
  // 날짜를 안 고르고 검색한 경우 땡큐캠핑이 돌려주는 잔여석 수는 특정 날짜 기준이 아니라 오해를
  // 살 수 있어(선택한 여행 날짜와 무관), 대신 날짜를 고르라는 안내만 보여준다.
  if (!lastSearchHadDates) {
    return '<span class="avail">날짜를 선택하면 빈자리를 확인할 수 있어요</span>';
  }
  if (item.totalSites == null || item.availableSites == null) {
    return '<span class="avail">잔여석 정보 없음</span>';
  }
  const ok = item.availableSites > 0;
  return `<span class="avail ${ok ? 'ok' : 'none'}">${ok ? `잔여 ${item.availableSites}/${item.totalSites}` : '예약 마감'}</span>`;
}

// 같은 캠핑장이 여러 플랫폼에 등록돼 있으면(item.links.length > 1) 플랫폼 태그도, 이동 링크도
// 여러 개 보여줘서 사용자가 원하는 곳(자주 쓰는 결제수단 등)을 직접 고를 수 있게 한다.
function platformTagsHtml(item) {
  const platforms = item.links && item.links.length > 1 ? item.links.map((l) => l.platform) : [item.platform];
  return platforms.map((p) => `<span class="platform-tag ${esc(p)}">${esc(p)}</span>`).join('');
}

// 땡큐캠핑 링크는 날짜를 골랐으면 res_dt/res_edt가 붙어서 검색할 때마다 문자열이 달라진다 -
// 즐겨찾기 여부/저장은 이 날짜 파라미터를 빼고 비교해야 날짜를 바꿔 검색해도 별표가 안 꺼진다.
function stripDateParams(link) {
  try {
    const u = new URL(link);
    u.searchParams.delete('res_dt');
    u.searchParams.delete('res_edt');
    return u.toString();
  } catch (e) {
    return link;
  }
}

async function loadFavorites() {
  const res = await fetch('/api/favorites');
  if (res.status === 401) return;
  const data = await res.json();
  favoriteLinks = new Set((data.items || []).flatMap((f) => (f.links || []).map((l) => stripDateParams(l.link))));
}

// 합쳐진 카드는 링크가 여러 개라, 그중 하나라도 즐겨찾기에 있으면 즐겨찾기된 것으로 본다 -
// 검색마다 어떤 플랫폼들이 잡히는지 달라질 수 있어서(예: 이번엔 네이버가 안 잡힐 수도 있음) 이래야
// 다음 검색에서도 별표가 꺼지지 않는다.
function isFavorited(item) {
  return (item.links || []).some((l) => favoriteLinks.has(stripDateParams(l.link)));
}

// 즐겨찾기한 항목을 맨 위로, 그 안에서는 기존 정렬(가격순)을 그대로 유지한다.
function sortFavoritesFirst(items) {
  const fav = [];
  const rest = [];
  items.forEach((item) => (isFavorited(item) ? fav : rest).push(item));
  return [...fav, ...rest];
}

function favBtnHtml(item) {
  const active = isFavorited(item);
  return `<button type="button" class="fav-btn${active ? ' active' : ''}" data-fav-link="${esc(item.link)}" title="${active ? '즐겨찾기 해제' : '즐겨찾기에 추가'}">${active ? '★' : '☆'}</button>`;
}

async function toggleFavorite(link) {
  const item = itemsByLink.get(link);
  if (!item) return;
  const active = isFavorited(item);
  // 저장/삭제는 항상 날짜 파라미터를 뺀 링크로 한다 - 그래야 어떤 날짜로 검색해서 즐겨찾기했든
  // 나중에 다른 날짜로 검색해도 같은 캠핑장으로 인식된다.
  const cleanLinks = (item.links || []).map((l) => ({ ...l, link: stripDateParams(l.link) }));
  const cleanPrimaryLink = stripDateParams(item.link);
  try {
    if (active) {
      await fetch('/api/favorites', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link: cleanPrimaryLink }),
      });
      cleanLinks.forEach((l) => favoriteLinks.delete(l.link));
    } else {
      await fetch('/api/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          link: cleanPrimaryLink, name: item.name, addr: item.addr, price: item.price,
          thumbnail: item.thumbnail, links: cleanLinks,
        }),
      });
      cleanLinks.forEach((l) => favoriteLinks.add(l.link));
    }
  } catch (err) {
    statusEl.className = 'error';
    statusEl.textContent = '즐겨찾기 저장 실패: ' + err.message;
    return;
  }
  renderResultsFromCache();
}

resultsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.fav-btn');
  if (!btn) return;
  toggleFavorite(btn.dataset.favLink);
});

mapCarouselEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.fav-btn');
  if (!btn) return;
  toggleFavorite(btn.dataset.favLink);
});

function renderResultsFromCache() {
  const sorted = sortFavoritesFirst(lastListItems);
  resultsEl.innerHTML = sorted.map(cardHtml).join('') || '<p>검색 결과가 없습니다.</p>';
  if (mapMode) renderMarkersAndCarousel(sortFavoritesFirst(allMapItems));
}

function platformLinksHtml(item) {
  const links = item.links && item.links.length ? item.links : [{ platform: item.platform, link: item.link, price: item.price }];
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
      ${favBtnHtml(item)}
      ${img}
      <div class="card-body">
        <div class="platform-tags">${platformTagsHtml(item)}</div>
        <h3>${esc(item.name)}</h3>
        <div class="addr">${esc(item.addr || '')}</div>
        <div class="price">${won(item.price)}</div>
        ${availabilityHtml(item)}
        <div class="amenities">${amenities}</div>
        ${platformLinksHtml(item)}
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
      ${favBtnHtml(item)}
      ${img}
      <div class="carousel-card-body">
        <div class="platform-tags">${platformTagsHtml(item)}</div>
        <h4>${esc(item.name)}</h4>
        <div class="addr">${esc(item.addr || '')}</div>
        <div class="price">${won(item.price)}</div>
        ${platformLinksHtml(item)}
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
      // "사이트에서 보기" 링크나 즐겨찾기 버튼 클릭은 지도 이동을 트리거하지 않는다.
      if (e.target.closest('a') || e.target.closest('.fav-btn')) return;
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
        content: `<div class="map-price-marker platform-${esc(item.platform)}" data-link="${esc(item.link)}">${isFavorited(item) ? '<span class="marker-star">★</span>' : ''}${won(item.price)}</div>`,
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
  renderMarkersAndCarousel(sortFavoritesFirst(withCoords));

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
  lastSearchHadDates = Boolean(params.get('checkin') && params.get('checkout'));
  statusEl.className = '';
  statusEl.textContent = '검색 중... (캠핏·네이버는 브라우저를 여는 방식이라 느릴 때는 최대 1분까지 걸릴 수 있어요)';
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

    lastListItems = data.items;
    itemsByLink = new Map(data.items.map((item) => [item.link, item]));
    resultsEl.innerHTML = sortFavoritesFirst(data.items).map(cardHtml).join('') || '<p>검색 결과가 없습니다.</p>';

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
// 저장된 필터 선호를 먼저 받아와야 loadMeta()가 칩을 렌더링할 때부터 반영된 상태로 그려진다.
// 즐겨찾기 상태도 첫 검색 결과의 별표/정렬이 처음부터 맞게 나오려면 검색 전에 받아와야 한다.
(async () => {
  await loadSearchPrefs();
  await loadMeta();
  syncPlatformChipUI();
  await loadFavorites();
  form.dispatchEvent(new Event('submit'));
})();
