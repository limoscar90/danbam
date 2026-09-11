require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { chromium } = require('playwright');
const userStore = require('./lib/userStore');

const AUTH_ENABLED = process.env.ENABLE_AUTH === 'true';

const PORT = process.env.PORT || 5173;
const SESSION_SECRET = process.env.SESSION_SECRET || 'danbam-dev-secret-change-me';

// 캠핏/땡큐캠핑/네이버 세 외부 사이트 중 하나가 타임아웃/에러를 내도 서버 전체가 죽지 않게 하는
// 안전장치. 제대로 된 고침은 에러가 나는 지점을 직접 고치는 것(예: searchNaver의 Promise.all
// 패턴)이지만, 예상 못한 비슷한 버그가 또 생겨도 이거 하나로 서버 전체가 다운되는 건 막는다.
process.on('unhandledRejection', (err) => {
  console.error('처리되지 않은 Promise 거부(서버는 계속 실행됨):', err);
});

// --- 땡큐캠핑 편의시설 코드 -> 라벨 매핑 (필터 UI에서 확보) ---
const THANKQ_SPEC_LABELS = {
  BM000: '개별화장실', BM001: '개별샤워실', BL004: '매점', BL003: '와이파이',
  BM007: '놀이터', BM013: '수영장', BN000: '장비대여', BM020: '체험활동',
  BO005: '등산', BO000: '해수욕장', BO002: '수상레져', BO003: '낚시',
  BO007: '스키장', BO006: '수목원/휴양림', BP000: '반려견동반', BP001: '트레일러 진입',
  BP002: '카라반 진입', BP003: '차박캠핑',
  EA000: '뷰 맛집', EA001: '조용한 힐링 맛집', EA002: '사진 맛집', EA003: '시원한 그늘 맛집',
  EB000: '반려견과 함께', EB001: '아이들과 함께', EB002: '연인과 함께', EB003: '친구들과 함께',
  EC000: '깨끗한 시설', EC001: '럭셔리 시설', EC002: '넓은 사이트 간격', EC003: '다양한 놀이시설',
  ED000: '친절한 사장님', ED001: '매너타임',
};

const THANKQ_SITE_TYPE = { '': '전체', BB000: '오토캠핑', BB001: '글램핑', BB002: '카라반', BB003: '펜션' };

// 플랫폼마다 편의시설 표기가 달라("해수욕장"/"바다", "수상레져"/"수상레저") 라벨 부분일치로 묶는
// 공통 필터 태그. group은 프런트에서 칩을 묶어 보여줄 때 쓴다.
// 캠핏에만 있는 정보(노키즈, 사이트 환경)라 땡큐캠핑에는 항상 없음 -> unsupportedPlatforms로 표시해서
// matchesFilters()가 그 플랫폼 아이템은 통과시키고, /api/search가 notices에 안내를 붙인다.
const FILTER_TAGS = [
  { key: 'pet', group: '예약 옵션', label: '반려동물 동반', match: ['반려'] },
  { key: 'noKids', group: '예약 옵션', label: '노키즈', match: ['노키즈'], unsupportedPlatforms: ['땡큐캠핑'] },
  { key: 'individualToilet', group: '시설', label: '개별화장실', match: ['개별화장실'] },
  { key: 'individualShower', group: '시설', label: '개별샤워실', match: ['개별샤워실'] },
  { key: 'pool', group: '시설', label: '수영장', match: ['수영장'] },
  { key: 'playground', group: '시설', label: '놀이시설', match: ['놀이터', '놀이시설'] },
  { key: 'store', group: '시설', label: '카페/매점', match: ['매점', '카페'] },
  { key: 'hiking', group: '주변·레저', label: '등산', match: ['등산'] },
  { key: 'waterLeisure', group: '주변·레저', label: '수상레저', match: ['수상레'] },
  { key: 'fishing', group: '주변·레저', label: '낚시', match: ['낚시'] },
  { key: 'forestLodge', group: '주변·레저', label: '휴양림', match: ['휴양림'] },
  { key: 'ocean', group: '주변·레저', label: '바다', match: ['바다', '해수욕장'] },
  { key: 'floorGrass', group: '사이트 환경', label: '잔디', match: ['잔디'], unsupportedPlatforms: ['땡큐캠핑'] },
  { key: 'floorDeck', group: '사이트 환경', label: '데크', match: ['데크'], unsupportedPlatforms: ['땡큐캠핑'] },
  { key: 'floorCrushedStone', group: '사이트 환경', label: '파쇄석', match: ['파쇄석'], unsupportedPlatforms: ['땡큐캠핑'] },
  { key: 'floorSoilCement', group: '사이트 환경', label: '마사토', match: ['마사토'], unsupportedPlatforms: ['땡큐캠핑'] },
  { key: 'floorSand', group: '사이트 환경', label: '모래', match: ['모래'], unsupportedPlatforms: ['땡큐캠핑'] },
  { key: 'floorPebble', group: '사이트 환경', label: '자갈', match: ['자갈'], unsupportedPlatforms: ['땡큐캠핑'] },
  { key: 'floorMixed', group: '사이트 환경', label: '혼합', match: ['혼합'], unsupportedPlatforms: ['땡큐캠핑'] },
  { key: 'floorEtc', group: '사이트 환경', label: '기타(바닥재)', match: ['기타(바닥재)'], unsupportedPlatforms: ['땡큐캠핑'] },
];
const FILTER_TAG_BY_KEY = Object.fromEntries(FILTER_TAGS.map((t) => [t.key, t]));

// 캠핏 존(zone) floorType 코드 -> 한글 라벨 (캠핏 검색 필터 UI에서 실측: 파쇄석/데크/잔디/마사토/모래/자갈/혼합/기타)
const CAMFIT_FLOOR_TYPE_LABELS = {
  crushedStone: '파쇄석', deck: '데크', grass: '잔디', soilCement: '마사토',
  sand: '모래', pebble: '자갈', mixed: '혼합', etc: '기타(바닥재)',
};

// --- 캠핏 편의시설/레저/타입 코드 -> 라벨 매핑 (캠핏 정적 JS 번들에서 확보) ---
const CAMFIT_LABEL_MAP = {
  autoCamping: '오토캠핑', glamping: '글램핑', caravan: '카라반진입', pension: '펜션',
  bungalow: '방갈로', carCamping: '차박', rental: '대여', experience: '체험',
  forest: '숲', ocean: '바다', mountain: '산', river: '강', lake: '호수',
  valley: '계곡', island: '섬', flat: '평야', etc: '기타',
  forestLodge: '휴양림', hiking: '등산', waterLeisure: '수상레저', fishing: '낚시',
  individualRoom: '개별화장실/샤워실', showerRoom: '샤워실', swimmingPool: '수영장',
  warmpool: '온수수영장', playground: '놀이시설', trampoline: '트램펄린',
  store: '카페/매점', bbq: '바베큐장', carCharger: '전기차충전소', sauna: '찜질방',
  canBringPet: '반려견 동반', canCampnic: '캠프닉',
  mudFlat: '갯벌체험', farm: '농장체험', animal: '동물체험', activity: '체험활동',
  restroom: '화장실', individualRestroom: '개별화장실', individualShowerRoom: '개별샤워실',
  sink: '개수대', cafe: '카페', wifi: '와이파이', trail: '산책로', rent: '장비대여',
  pet: '반려동물', trailer: '트레일러진입', zipline: '짚라인', sled: '썰매장',
  storage: '장비보관', site: '텐트 옆 주차', beach: '해수욕장', mtb: 'MTB',
  ski: '스키', golf: '골프',
};
const camfitLabel = (code) => CAMFIT_LABEL_MAP[code] || code;

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// --- 땡큐캠핑: 일반 HTTP 요청으로 충분 (봇 차단 없음) ---
async function searchThankQ({ sido, sigungu, checkin, checkout, adults, siteType }) {
  const body = new URLSearchParams({
    region: sido || '',
    sub_region: sigungu || '',
    site_tp: siteType || '',
    ser_disc_yn: '', ser_empty_yn: '', ser_pg_tp: '', ser_long_yn: '',
    ser_keyword: '', ser_sort: 'R', ser_camp_spec: '', ser_camp_position: '',
    ser_key_sub_cd2: '', ser_q_point: '', ser_deposit_yn: '', ser_new_yn: '',
    ser_kid: '', ser_key_cd: '', ser_key_sub_cd: '', ser_festa_gbn: '',
    ser_2peopleOnly: '',
    ser_res_dt: checkin, ser_res_edt: checkout,
    ser_only_able: '', ser_get_coupon_yn: '', ser_st: 'N',
    ser_adult_count: String(adults || 2), ser_child_count: '0',
    festa_yn: '', view_type: 'PIC', is_empty_button: 'N', page_num: '1',
  });

  const res = await fetch('https://m.thankqcamping.com/resv/ax_list_search.hbb', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': 'https://m.thankqcamping.com/resv/list.hbb',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`땡큐캠핑 응답 오류: ${res.status}`);
  const json = await res.json();
  const list = (json && json.data && json.data.campList) || [];

  return list.map((c) => ({
    platform: '땡큐캠핑',
    name: c.campName,
    addr: c.addr,
    price: c.minSalePrice ?? c.minBasicPrice ?? null,
    totalSites: c.siteCnt ?? null,
    availableSites: c.ableCnt ?? null,
    amenities: (c.campSpecs || []).map((code) => THANKQ_SPEC_LABELS[code]).filter(Boolean),
    reviewCount: c.brdCnt ?? null,
    thumbnail: c.campPicList && c.campPicList[0] ? c.campPicList[0].imgUrl : null,
    // 예전에 쓰던 camp_detail.hbb?camp_seq=는 404 나는 잘못된 경로였다 - 실제 사이트에서 직접
    // 확인한 진짜 상세페이지 경로(view.hbb?cseq=)로 교체.
    link: `https://m.thankqcamping.com/resv/view.hbb?cseq=${c.campSeq}&res_dt=${checkin}&res_edt=${checkout}`,
  }));
}

// --- 캠핏: Cloudflare 봇 차단이 있어 실제 브라우저(Playwright) 컨텍스트에서 호출 ---
let browserPromise = null;
let camfitPagePromise = null;

async function getBrowser() {
  if (!browserPromise) browserPromise = chromium.launch({ headless: true });
  return browserPromise;
}

async function getCamfitPage() {
  if (!camfitPagePromise) {
    camfitPagePromise = (async () => {
      const browser = await getBrowser();
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      });
      const page = await context.newPage();
      await page.goto('https://camfit.co.kr/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500); // Cloudflare 챌린지 통과 대기
      return page;
    })().catch((err) => {
      camfitPagePromise = null; // 실패 시 캐시를 비워서 다음 요청이 재시도하게 한다.
      throw err;
    });
  }
  return camfitPagePromise;
}

// 캐싱해둔 페이지가 한 번 쓰이고 나면 Cloudflare 재검증 등으로 이후 fetch가 조용히 막히는 경우가
// 있어("Failed to fetch"), 실패 시 캐시를 버리고 새 페이지로 한 번 재시도한다.
async function searchCamfit(args) {
  try {
    return await searchCamfitAttempt(args);
  } catch (err) {
    console.error('캠핏 검색 실패, 새 페이지로 재시도:', err.message);
    camfitPagePromise = null;
    return await searchCamfitAttempt(args);
  }
}

async function searchCamfitAttempt({ sido, sigungu, adults, hasNameOrFilter, filterKeys = [] }) {
  const page = await getCamfitPage();
  const params = {
    adult: String(adults || 2),
    isSale: 'false',
    isOnlyAvailable: 'false',
    skip: '0',
    // cities/majors 둘 다 있어야 지역이 실제로 걸러진다(하나만 있으면 캠핏 API가 전국 결과를 그대로 반환).
    // 지역 없이 이름/필터로만 찾을 때는 걸러낼 재료(이름)가 필요하니 풀을 넉넉히 받아온다.
    limit: sido && sigungu ? '30' : hasNameOrFilter ? '80' : '30',
  };
  if (sido && sigungu) {
    params.cities = sido;
    params.majors = sigungu;
    params.cityAndMajors = `${sido}-${sigungu}`;
  }
  const qs = new URLSearchParams(params);
  const url = `https://api.camfit.co.kr/v3/search?${qs.toString()}`;

  const data = await page.evaluate(async (u) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error('camfit http ' + r.status);
    return r.json();
  }, url);

  const list = (data && data.data) || [];

  // 검색 응답엔 편의시설이 없어서, 캠핑장 상세 API를 병렬로 붙여서 가져온다.
  const ids = list.map((c) => c._id);
  const detailsById = await page.evaluate(async (campIds) => {
    const entries = await Promise.all(
      campIds.map(async (id) => {
        try {
          const r = await fetch(`https://api.camfit.co.kr/v1/camps/${id}`);
          if (!r.ok) return [id, null];
          const d = await r.json();
          return [id, {
            facilities: d.facilities || [],
            additionalFacilities: d.additionalFacilities || [],
            services: d.services || [],
            activities: d.activities || [],
            leisureTypes: d.leisureTypes || [],
            address: d.address1 || null, // 지오코딩용 - 검색 응답의 city+major만으론 좌표 정확도가 너무 낮다
          }];
        } catch (e) {
          return [id, null];
        }
      })
    );
    return Object.fromEntries(entries);
  }, ids);

  // 사이트 환경(바닥재)은 캠프가 아니라 존(zone) 단위 정보라 /v1/zones/{id}를 따로 불러야 한다
  // (검색/상세 API 응답엔 없음, 실측 확인됨). 존이 여러 개면 하나라도 해당 바닥재면 그 캠프도 매칭되게
  // OR으로 합친다. 매 검색마다 캠프당 존 여러 개를 병렬로 더 불러오는 비용이 있어, 사이트 환경 필터가
  // 실제로 선택된 경우에만 수행한다.
  const wantsFloorType = filterKeys.some((k) => FILTER_TAG_BY_KEY[k] && FILTER_TAG_BY_KEY[k].group === '사이트 환경');
  let floorLabelsByCamp = {};
  if (wantsFloorType) {
    const zoneIdsByCamp = Object.fromEntries(list.map((c) => [c._id, (c.zones || []).map((z) => z._id)]));
    const allZoneIds = [...new Set(Object.values(zoneIdsByCamp).flat())];
    const floorTypeByZone = await page.evaluate(async (zoneIds) => {
      const entries = await Promise.all(
        zoneIds.map(async (id) => {
          try {
            const r = await fetch(`https://api.camfit.co.kr/v1/zones/${id}`);
            if (!r.ok) return [id, null];
            const d = await r.json();
            return [id, d.floorType || null];
          } catch (e) {
            return [id, null];
          }
        })
      );
      return Object.fromEntries(entries);
    }, allZoneIds);
    floorLabelsByCamp = Object.fromEntries(
      Object.entries(zoneIdsByCamp).map(([campId, zoneIds]) => [
        campId,
        [...new Set(zoneIds.map((zid) => floorTypeByZone[zid]).filter(Boolean).map((code) => CAMFIT_FLOOR_TYPE_LABELS[code] || code))],
      ])
    );
  }

  // 노키즈는 캠프/존 상세 응답 어디에도 공개된 필드가 없어(agePolicy는 노키즈 캠핑장에서도 항상
  // enabled:false로 확인됨) 캠핏 검색 자체가 지원하는 reservationOptions=noKids 파라미터로
  // 별도 조회해 매칭되는 캠프 id 집합을 구한다. 노키즈 필터가 선택된 경우에만 수행한다.
  let noKidsIds = new Set();
  if (filterKeys.includes('noKids')) {
    const noKidsQs = new URLSearchParams({ ...params, reservationOptions: 'noKids', limit: '200' });
    const noKidsUrl = `https://api.camfit.co.kr/v3/search?${noKidsQs.toString()}`;
    const noKidsCampIds = await page.evaluate(async (u) => {
      try {
        const r = await fetch(u);
        if (!r.ok) return [];
        const j = await r.json();
        return (j.data || []).map((c) => c._id);
      } catch (e) {
        return [];
      }
    }, noKidsUrl);
    noKidsIds = new Set(noKidsCampIds);
  }

  return list.map((c) => {
    const zones = c.zones || [];
    const availableZones = zones.filter((z) => z.isAvailable).length;
    const detail = detailsById[c._id];
    const codes = detail
      ? [...detail.facilities, ...detail.additionalFacilities, ...detail.services, ...detail.activities]
      : [];
    const amenities = new Set(codes.map(camfitLabel));
    (floorLabelsByCamp[c._id] || []).forEach((label) => amenities.add(label));
    if (noKidsIds.has(c._id)) amenities.add('노키즈');
    return {
      platform: '캠핏',
      name: c.name,
      addr: (detail && detail.address) || `${c.city} ${c.major}`,
      price: c.priceStartFrom ?? null,
      totalSites: zones.length || null,
      availableSites: zones.length ? availableZones : null,
      amenities: [...amenities],
      reviewCount: c.numOfReviews ?? null,
      thumbnail: c.medias && c.medias[0] ? c.medias[0] : null,
      link: `https://camfit.co.kr/camp/${c._id}`,
    };
  });
}

// --- 네이버: 실시간 잔여석 없이 지도 장소검색 API(map.naver.com)만 제공 ---
let naverPagePromise = null;

async function getNaverPage() {
  if (!naverPagePromise) {
    naverPagePromise = (async () => {
      const browser = await getBrowser();
      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      });
      return context.newPage();
    })().catch((err) => {
      naverPagePromise = null;
      throw err;
    });
  }
  return naverPagePromise;
}

function parseNaverPrice(menuInfo) {
  if (!menuInfo) return null;
  // 네이버 메뉴판 텍스트는 "오토캠핑장 15,000~20,000 | 카라반 ..." 또는
  // "평일 35,000 | 주말 45,000" 처럼 형식이 제각각이라, 뒤따르는 기호(~,원)에
  // 기대지 않고 천단위 콤마가 있는 첫 숫자를 가격으로 본다.
  const m = menuInfo.match(/([1-9]\d{0,2}(?:,\d{3})+)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

// 같은 캠핑장이 여러 플랫폼(네이버/캠핏/땡큐캠핑)에 동시에 등록된 경우, 카드 하나로 묶어서
// 사용자가 원하는 플랫폼(결제 수단 등)을 직접 골라 들어갈 수 있게 한다. 플랫폼마다 표기가 조금씩
// 달라서(괄호 안 부연설명, "前 ○○" 같은 구 이름 등) 이름+대략적인 지역(시/도+시/군/구)이 둘 다
// 맞을 때만 같은 캠핑장으로 본다 - 이름만 보면 흔한 이름이 많아 다른 캠핑장을 잘못 묶을 수 있다.
function normalizeCampName(name) {
  return (name || '')
    .replace(/\(.*?\)/g, '')
    .replace(/[\s·\-]/g, '')
    .replace(/캠핑장|오토캠핑|캠핑|글램핑|펜션|카라반/g, '')
    .toLowerCase();
}

function regionKey(addr) {
  if (!addr) return '';
  const tokens = addr.trim().split(/\s+/);
  const sido = (tokens[0] || '').replace(/(특별자치도|특별자치시|광역시|특별시|도)$/, '');
  return `${sido}|${tokens[1] || ''}`;
}

function dedupeByCamp(items) {
  const groups = new Map();
  items.forEach((item) => {
    const nameKey = normalizeCampName(item.name);
    const key = nameKey ? `${nameKey}|${regionKey(item.addr)}` : `__unique_${groups.size}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });

  return [...groups.values()].map((group) => {
    if (group.length === 1) {
      const item = group[0];
      return { ...item, links: [{ platform: item.platform, link: item.link, price: item.price }] };
    }
    const primary = [...group].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))[0];
    const withCoords = group.find((i) => i.lat != null && i.lng != null);
    return {
      ...primary,
      amenities: [...new Set(group.flatMap((i) => i.amenities || []))],
      lat: withCoords ? withCoords.lat : primary.lat,
      lng: withCoords ? withCoords.lng : primary.lng,
      links: group.map((i) => ({ platform: i.platform, link: i.link, price: i.price })),
    };
  });
}

// filters(선택된 태그 키 배열)를 모두 만족하는지 라벨 부분일치로 판단한다(AND 조건).
function matchesFilters(item, filterKeys) {
  const amenities = item.amenities || [];
  return filterKeys.every((key) => {
    const tag = FILTER_TAG_BY_KEY[key];
    if (!tag) return true;
    if (tag.unsupportedPlatforms && tag.unsupportedPlatforms.includes(item.platform)) return true;
    return amenities.some((a) => tag.match.some((m) => a.includes(m)));
  });
}

// 캠핏/땡큐캠핑은 좌표를 안 줘서, 네이버 지도 Geocoding API로 주소를 좌표로 바꾼다.
// 같은 캠핑장 주소가 재검색마다 반복되니 프로세스 생명주기 동안은 캐싱해서 호출을 아낀다.
const geocodeCache = new Map();
async function geocodeAddress(address) {
  if (!address) return null;
  if (geocodeCache.has(address)) return geocodeCache.get(address);
  const clientId = process.env.NCP_MAPS_CLIENT_ID;
  const clientSecret = process.env.NCP_MAPS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null; // 키 없으면 지도 기능만 조용히 빠진다 (검색 자체는 그대로 동작)
  try {
    const url = `https://maps.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      headers: {
        'x-ncp-apigw-api-key-id': clientId,
        'x-ncp-apigw-api-key': clientSecret,
      },
    });
    if (!res.ok) return null;
    const json = await res.json();
    const first = json.addresses && json.addresses[0];
    const result = first ? { lat: Number(first.y), lng: Number(first.x) } : null;
    geocodeCache.set(address, result);
    return result;
  } catch (e) {
    return null;
  }
}

async function searchNaver(args) {
  try {
    return await searchNaverAttempt(args);
  } catch (err) {
    console.error('네이버 검색 실패, 새 페이지로 재시도:', err.message);
    naverPagePromise = null;
    return await searchNaverAttempt(args);
  }
}

async function searchNaverAttempt({ sido, sigungu, keyword }) {
  const queryParts = [sido, sigungu, keyword, '캠핑장'].filter(Boolean);
  if (!sido && !sigungu && !keyword) return []; // 검색어가 전혀 없으면 지도 중심 위치 기준으로만 나와 의미가 없다.
  const page = await getNaverPage();
  const query = queryParts.join(' ');
  const searchUrl = `https://map.naver.com/p/search/${encodeURIComponent(query)}`;

  // waitForResponse를 만들어두고 goto 이후에 따로 await하면, goto가 오래 걸리는 사이 응답
  // 대기가 먼저 타임아웃될 때 "핸들러가 아직 안 붙은 상태의 reject"가 생겨서 Node 프로세스 전체가
  // 죽는 문제가 있었다(Promise.allSettled로도 못 막음). Promise.all로 두 프로미스를 같은 시점에
  // 묶어서 이 문제를 없앤다 - Playwright 공식 문서에서 권장하는 패턴이기도 하다.
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/p/api/search/allSearch'), { timeout: 20000 }),
    page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }),
  ]);
  const json = await res.json();

  const list = (json && json.result && json.result.place && json.result.place.list) || [];
  return list
    .filter((p) => (p.category || []).some((c) => c.includes('캠핑') || c.includes('야영')))
    .map((p) => ({
      platform: '네이버',
      name: p.name,
      addr: p.roadAddress || p.address || '',
      price: parseNaverPrice(p.menuInfo),
      totalSites: null,
      availableSites: null,
      amenities: [],
      reviewCount: (p.reviewCount ?? p.placeReviewCount) || null,
      thumbnail: p.thumUrl || (p.thumUrls && p.thumUrls[0]) || null,
      link: `https://m.place.naver.com/place/${p.id}/home`,
      // 네이버 검색 응답엔 좌표가 그대로 들어있어 지오코딩이 필요 없다(x=경도, y=위도, 둘 다 문자열).
      lat: p.y ? Number(p.y) : null,
      lng: p.x ? Number(p.x) : null,
    }));
}

const app = express();
app.set('trust proxy', 1); // Render/Fly 같은 리버스 프록시 뒤에서 secure 쿠키가 제대로 동작하도록
app.use(express.json());

// 세션을 메모리에만 두면 Fly가 유휴 상태에서 머신을 재웠다 깨울 때(또는 재배포/크래시 시)
// 로그인이 전부 풀린다 - Supabase Postgres에 세션을 저장해서 서버가 몇 번을 다시 뜨든
// 로그인이 유지되게 한다. 인증 자체가 꺼져있으면(로컬 미리보기) DB가 없어도 되게 기본
// MemoryStore를 그대로 쓴다.
const sessionOptions = {
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 3600 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  },
};
if (AUTH_ENABLED) {
  const pgSession = require('connect-pg-simple')(session);
  const { getPool } = require('./lib/db');
  sessionOptions.store = new pgSession({ pool: getPool(), tableName: 'session', createTableIfMissing: true });
}
app.use(session(sessionOptions));

function requirePageAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (req.session && req.session.userId) return next();
  res.redirect('/login');
}

function requireApiAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: '로그인이 필요합니다.' });
}

// index.html은 로그인 확인 후 직접 내려주므로 static 미들웨어의 자동 index 서빙은 끈다.
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.post('/api/signup', async (req, res) => {
  const email = userStore.normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: '올바른 이메일 형식이 아닙니다.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: '비밀번호는 8자 이상이어야 합니다.' });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await userStore.createUser(email, passwordHash);
    req.session.userId = user.id;
    req.session.email = user.email;
    res.json({ email: user.email });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.post('/api/login', async (req, res) => {
  const email = userStore.normalizeEmail(req.body.email);
  const password = String(req.body.password || '');
  const user = await userStore.findByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }
  req.session.userId = user.id;
  req.session.email = user.email;
  res.json({ email: user.email });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (req.session && req.session.userId) return res.json({ email: req.session.email });
  if (!AUTH_ENABLED) return res.json({ email: null });
  res.status(401).json({ error: '로그인이 필요합니다.' });
});

app.get('/api/meta', requireApiAuth, (req, res) => {
  res.json({
    siteTypes: THANKQ_SITE_TYPE,
    filterTags: FILTER_TAGS,
    // Client ID는 지도 SDK 로드용으로 브라우저에 그대로 노출돼도 되는 값이다(Secret은 서버에만 둔다).
    naverMapsClientId: process.env.NCP_MAPS_CLIENT_ID || null,
  });
});

app.get('/api/search', requireApiAuth, async (req, res) => {
  const { sido, sigungu, adults, siteType } = req.query;
  const keyword = (req.query.keyword || '').trim();
  const filterKeys = (req.query.filters || '').split(',').map((s) => s.trim()).filter(Boolean);
  const hasNameOrFilter = Boolean(keyword) || filterKeys.length > 0;
  const onlyAvailable = req.query.onlyAvailable === 'true';
  const wantsMap = req.query.map === 'true';
  const checkinD = req.query.checkin ? new Date(req.query.checkin) : new Date(Date.now() + 24 * 3600 * 1000);
  const checkoutD = req.query.checkout ? new Date(req.query.checkout) : new Date(checkinD.getTime() + 24 * 3600 * 1000);
  const checkin = fmtDate(checkinD);
  const checkout = fmtDate(checkoutD);

  const [thankqResult, camfitResult, naverResult] = await Promise.allSettled([
    searchThankQ({ sido, sigungu, checkin, checkout, adults: Number(adults) || 2, siteType }),
    searchCamfit({ sido, sigungu, adults: Number(adults) || 2, hasNameOrFilter, filterKeys }),
    searchNaver({ sido, sigungu, keyword }),
  ]);

  const errors = [];
  const notices = [];
  let items = [];
  if (thankqResult.status === 'fulfilled') items.push(...thankqResult.value);
  else errors.push({ platform: '땡큐캠핑', message: String(thankqResult.reason) });

  if (camfitResult.status === 'fulfilled') items.push(...camfitResult.value);
  else errors.push({ platform: '캠핏', message: String(camfitResult.reason) });

  if (naverResult.status === 'fulfilled') items.push(...naverResult.value);
  else errors.push({ platform: '네이버', message: String(naverResult.reason) });

  // 캠핏/땡큐캠핑 모두 검색어 파라미터를 실제로는 걸러주지 않아(확인됨), 이름 검색은
  // 넓게 받아온 결과를 이름 문자열로 직접 한 번 더 거른다.
  if (keyword) {
    const kw = keyword.toLowerCase();
    items = items.filter((i) => (i.name || '').toLowerCase().includes(kw));
  }

  if (filterKeys.length) {
    items = items.filter((i) => i.platform === '네이버' || matchesFilters(i, filterKeys));
    if (items.some((i) => i.platform === '네이버')) {
      notices.push('네이버 결과는 필터로 사용한 정보(반려동물, 편의시설 등)를 제공하지 않아 필터와 무관하게 모두 표시됩니다.');
    }
    const unsupportedByThankQ = filterKeys
      .map((k) => FILTER_TAG_BY_KEY[k])
      .filter((tag) => tag && tag.unsupportedPlatforms && tag.unsupportedPlatforms.includes('땡큐캠핑'));
    if (unsupportedByThankQ.length && items.some((i) => i.platform === '땡큐캠핑')) {
      const labels = unsupportedByThankQ.map((tag) => tag.label).join(', ');
      notices.push(`땡큐캠핑은 ${labels} 정보를 제공하지 않아 해당 필터와 무관하게 모두 표시됩니다.`);
    }
  }

  if (onlyAvailable) {
    items = items.filter((i) => i.availableSites == null || i.availableSites > 0);
    if (items.some((i) => i.availableSites == null)) {
      notices.push('네이버 결과는 실시간 잔여석 정보를 제공하지 않아 예약 가능 필터와 무관하게 모두 표시됩니다.');
    }
  }

  items.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

  // 지오코딩(주소->좌표)은 외부 API 호출 비용이 있어, 지도 뷰를 실제로 켰을 때만(map=true) 수행한다.
  if (wantsMap) {
    await Promise.all(
      items
        .filter((i) => i.lat == null || i.lng == null)
        .map(async (i) => {
          const coords = await geocodeAddress(i.addr);
          if (coords) {
            i.lat = coords.lat;
            i.lng = coords.lng;
          }
        })
    );
    if (!process.env.NCP_MAPS_CLIENT_ID) {
      notices.push('네이버 지도 API 키가 설정되지 않아 캠핏/땡큐캠핑 결과는 지도에 표시되지 않습니다.');
    }
  }

  items = dedupeByCamp(items);
  items.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

  res.json({ checkin, checkout, count: items.length, items, errors, notices });
});

async function start() {
  if (AUTH_ENABLED) {
    const { ensureSchema } = require('./lib/db');
    await ensureSchema();
  }
  app.listen(PORT, () => {
    console.log(`DANBAM: http://localhost:${PORT}${AUTH_ENABLED ? ' (로그인 필요)' : ' (로그인 비활성화)'}`);
  });
}

start().catch((err) => {
  console.error('서버 시작 실패:', err.message);
  process.exit(1);
});

process.on('SIGINT', async () => {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
  }
  process.exit(0);
});
