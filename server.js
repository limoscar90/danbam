require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { chromium } = require('playwright');
const userStore = require('./lib/userStore');
const { getPool } = require('./lib/db');

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
    bookable: true, // 땡큐캠핑은 항상 실제 예약/결제가 되는 링크다
    name: c.campName,
    addr: c.addr,
    price: c.minSalePrice ?? c.minBasicPrice ?? null,
    totalSites: c.siteCnt ?? null,
    availableSites: c.ableCnt ?? null,
    amenities: (c.campSpecs || []).map((code) => THANKQ_SPEC_LABELS[code]).filter(Boolean),
    reviewCount: c.brdCnt ?? null,
    thumbnail: c.campPicList && c.campPicList[0] ? c.campPicList[0].imgUrl : null,
    // 예전에 쓰던 camp_detail.hbb?camp_seq=는 404 나는 잘못된 경로였다 - 실제 사이트에서 직접
    // 확인한 진짜 상세페이지 경로(view.hbb?cseq=)로 교체. 날짜를 안 골랐으면 res_dt/res_edt를
    // 아예 붙이지 않는다(빈 값으로 보내는 것보다 안전).
    link: `https://m.thankqcamping.com/resv/view.hbb?cseq=${c.campSeq}${checkin && checkout ? `&res_dt=${checkin}&res_edt=${checkout}` : ''}`,
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
      bookable: true, // 캠핏도 항상 실제 예약/결제가 되는 링크다
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

// 일부 캠핑장은 메뉴판(menuInfo) 대신 정식 "네이버 예약"(booking.naver.com)을 쓰기 때문에
// menuInfo가 아예 비어서 가격을 못 읽어오는 경우가 있다(실측: "캠프 네버랜드"). hasNaverBooking이면
// 검색 응답의 naverBookingUrl에서 사업장 id를 뽑아 booking.naver.com의 GraphQL API로 선택한
// 날짜의 실제 최저가를 직접 조회한다. Playwright 페이지가 아니라 일반 서버 fetch로 충분하다
// (브라우저 쿠키/세션이 필요 없는 공개 API로 확인됨).
async function fetchNaverBookingMinPrice(businessId, checkin, checkout) {
  try {
    const start = `${checkin.slice(0, 4)}-${checkin.slice(4, 6)}-${checkin.slice(6, 8)}`;
    const end = `${checkout.slice(0, 4)}-${checkout.slice(4, 6)}-${checkout.slice(6, 8)}`;
    const query = `query bizItems($input: BizItemsParams) {
      bizItems(input: $input) {
        minMaxPrice { minPrice }
        __typename
      }
    }`;
    const res = await fetch('https://booking.naver.com/graphql?opName=bizItems', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operationName: 'bizItems',
        variables: {
          input: { availableStartDate: start, availableEndDate: end, businessId, lang: 'ko', projections: 'MIN_MAX_PRICE' },
        },
        query,
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const items = json && json.data && json.data.bizItems;
    if (!items) return null;
    const prices = items.map((i) => i.minMaxPrice && i.minMaxPrice.minPrice).filter((p) => p != null);
    return prices.length ? Math.min(...prices) : null;
  } catch (e) {
    return null;
  }
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

// "충남"/"충청남도"처럼 흔한 줄임말과 정식 명칭의 글자 수가 아예 달라(끝의 "도"만 떼서는 못
// 맞춤) 충청/전라/경상 계열은 그냥 접미사 제거만으론 같은 지역으로 안 묶였다(태안군 실측에서
// 확인됨) - 시/도별로 정규화 규칙을 따로 둔다.
const SIDO_CANON = [
  [/^서울/, '서울'], [/^부산/, '부산'], [/^대구/, '대구'], [/^인천/, '인천'],
  [/^광주/, '광주'], [/^대전/, '대전'], [/^울산/, '울산'], [/^세종/, '세종'],
  [/^경기/, '경기'], [/^강원/, '강원'], [/^제주/, '제주'],
  [/^충청?북/, '충북'], [/^충청?남/, '충남'],
  [/^전라?북/, '전북'], [/^전라?남/, '전남'],
  [/^경상?북/, '경북'], [/^경상?남/, '경남'],
];

function canonicalSido(token) {
  const hit = SIDO_CANON.find(([re]) => re.test(token));
  if (hit) return hit[1];
  return (token || '').replace(/(특별자치도|특별자치시|광역시|특별시|도)$/, '');
}

function regionKey(addr) {
  if (!addr) return '';
  const tokens = addr.trim().split(/\s+/);
  return `${canonicalSido(tokens[0] || '')}|${tokens[1] || ''}`;
}

// 땡큐캠핑 링크는 날짜를 고르면 res_dt/res_edt가 붙어서 검색할 때마다 문자열이 달라진다 -
// 즐겨찾기 저장/조회는 이 파라미터를 뺀 링크로 비교해야 날짜가 바뀌어도 같은 캠핑장으로 인식된다.
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

// 캠핏은 이름 앞에 지역명을 붙이는 경우가 많아("태안 꿈꾸는바다캠핑장" vs 네이버의 "꿈꾸는바다
// 캠핑장") normalizeCampName만으로는 못 묶이는 경우가 실제로 꽤 있었다(춘천/태안 지역 실측 확인).
// 이런 "한쪽 이름이 다른 쪽을 포함하는" 경우는 상세주소(시/도, 시/군/구를 뺀 도로명+번지)까지
// 정확히 같을 때만 같은 캠핑장으로 본다 - 이름만 보고 묶으면 같은 도로에 있는 다른 캠핑장을
// 잘못 합칠 위험이 있어서다.
function normalizeAddrDetail(addr) {
  if (!addr) return '';
  const tokens = addr.trim().split(/\s+/).filter(Boolean).slice(2);
  return tokens
    .join(' ')
    .replace(/\(.*?\)/g, '')
    .replace(/\S*구역\s*$/, '')
    .replace(/\s+/g, '')
    .trim();
}

function dedupeByCamp(items) {
  const meta = items.map((item) => ({
    nameKey: normalizeCampName(item.name),
    regionKey: regionKey(item.addr),
    addrKey: normalizeAddrDetail(item.addr),
  }));

  const parent = items.map((_, i) => i);
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  for (let i = 0; i < items.length; i++) {
    if (!meta[i].nameKey || !meta[i].regionKey) continue;
    for (let j = i + 1; j < items.length; j++) {
      if (!meta[j].nameKey || meta[i].regionKey !== meta[j].regionKey) continue;
      if (meta[i].nameKey === meta[j].nameKey) {
        union(i, j);
        continue;
      }
      const shorter = Math.min(meta[i].nameKey.length, meta[j].nameKey.length);
      const oneContainsOther = meta[i].nameKey.includes(meta[j].nameKey) || meta[j].nameKey.includes(meta[i].nameKey);
      if (shorter >= 3 && oneContainsOther && meta[i].addrKey && meta[i].addrKey === meta[j].addrKey) {
        union(i, j);
      }
    }
  }

  const groups = new Map();
  items.forEach((item, idx) => {
    const key = meta[idx].nameKey ? find(idx) : `__unique_${idx}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });

  return [...groups.values()].map((group) => {
    if (group.length === 1) {
      const item = group[0];
      return { ...item, links: [{ platform: item.platform, link: item.link, price: item.price, bookable: item.bookable }] };
    }
    const primary = [...group].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity))[0];
    const withCoords = group.find((i) => i.lat != null && i.lng != null);
    return {
      ...primary,
      amenities: [...new Set(group.flatMap((i) => i.amenities || []))],
      lat: withCoords ? withCoords.lat : primary.lat,
      lng: withCoords ? withCoords.lng : primary.lng,
      // 실제 예약 가능한 링크(캠핏/땡큐캠핑은 항상, 네이버는 정식 네이버예약일 때만)를 앞에 오게
      // 정렬한다 - 정보성 페이지뿐인 플랫폼 때문에 예약처를 못 찾아 헤매지 않게.
      links: group
        .map((i) => ({ platform: i.platform, link: i.link, price: i.price, bookable: i.bookable }))
        .sort((a, b) => Number(Boolean(b.bookable)) - Number(Boolean(a.bookable))),
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

async function searchNaverAttempt({ sido, sigungu, keyword, checkin, checkout }) {
  // 지역/검색어가 전부 비어있어도("전체" 검색) '캠핑장'만으로 검색한다 - 네이버 지도는 위치 필터가
  // 없으면 자체 기본 정렬(인지도/리뷰 기준 상위 결과, 수도권에 몰리는 경향)로 상위 일부만 보여주지만,
  // 그래도 결과를 아예 안 보여주는 것보다는 낫다. 실측 확인: 지역 없이 '캠핑장'만 검색해도 정상적으로
  // 20건이 반환됨(전국 스캔은 아니고 네이버 자체 기본 노출 순서).
  const queryParts = [sido, sigungu, keyword, '캠핑장'].filter(Boolean);
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
  const results = list
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
      hasNaverBooking: p.hasNaverBooking || false,
      naverBookingUrl: p.naverBookingUrl || null,
    }));

  // menuInfo 기반 가격이 없는데 정식 네이버 예약을 쓰는 곳만 골라 실제 최저가를 추가로 조회한다
  // (모든 네이버 결과에 매번 조회하면 검색이 느려지고, 대부분은 menuInfo만으로 이미 가격이 있다).
  if (checkin && checkout) {
    await Promise.all(results.map(async (item) => {
      if (item.price != null || !item.hasNaverBooking || !item.naverBookingUrl) return;
      const businessId = (item.naverBookingUrl.match(/bizes\/(\d+)/) || [])[1];
      if (!businessId) return;
      item.price = await fetchNaverBookingMinPrice(businessId, checkin, checkout);
    }));
  }

  // 네이버는 hasNaverBooking(정식 네이버 예약)이 아니면 카드가 그냥 정보성 페이지라 실제 결제가
  // 안 된다(실측: "반하면오토캠핑장" - 네이버엔 있지만 예약은 캠핏에서만 됨). 합쳐진 카드에서
  // 진짜 예약 가능한 링크를 구분해 보여줄 수 있게 bookable로 남겨서 내려보낸다.
  return results.map(({ hasNaverBooking, naverBookingUrl, ...item }) => ({ ...item, bookable: hasNaverBooking }));
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

app.get('/favorites', requirePageAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favorites.html'));
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

// 회원가입 없이 바로 둘러보고 싶다는 요청 - 진짜 계정을 하나 만들어서 로그인 처리한다(즐겨찾기 등
// 다른 기능이 user_id FK로 걸려있어서, 진짜 유저 없이 특별 취급하면 여기저기 예외 처리가 필요해진다).
// 이메일은 로그인에 쓸 일이 없는 임의 문자열이라 비밀번호도 아무도 모르는 무작위 값으로 채운다.
app.post('/api/guest', async (req, res) => {
  try {
    const email = `guest-${crypto.randomUUID()}@danbam.guest`;
    const passwordHash = await bcrypt.hash(crypto.randomUUID(), 10);
    const user = await userStore.createUser(email, passwordHash);
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.isGuest = true;
    res.json({ email: user.email, isGuest: true });
  } catch (err) {
    res.status(500).json({ error: '체험 계정을 만들지 못했습니다.' });
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
  if (req.session && req.session.userId) {
    return res.json({ email: req.session.email, isGuest: !!req.session.isGuest });
  }
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

// 로그인할 때마다 필터를 다시 고르지 않아도 되게 마지막으로 쓴 조합을 계정에 저장/복원한다
// (반려동물 동반처럼 매번 켜야 하는 필터가 있다는 요청). 지역/날짜/숙소명 같은 그때그때 다른
// 검색어는 대상이 아니고, 숙소유형·예약옵션 등 "선호"에 가까운 칩 상태만 저장한다.
app.get('/api/search-prefs', requireApiAuth, async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const { rows } = await getPool().query('SELECT search_prefs FROM users WHERE id = $1', [userId]);
  res.json({ prefs: (rows[0] && rows[0].search_prefs) || null });
});

app.put('/api/search-prefs', requireApiAuth, async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const prefs = (req.body && req.body.prefs) || {};
  await getPool().query('UPDATE users SET search_prefs = $1 WHERE id = $2', [JSON.stringify(prefs), userId]);
  res.json({ ok: true });
});

// 검색은 로그인이 꺼진 로컬 개발(ENABLE_AUTH=false)에서도 되지만, 즐겨찾기는 사용자별 데이터라
// 실제 로그인한 사용자가 있을 때만 의미가 있다 - requireApiAuth의 AUTH_ENABLED 우회와 무관하게
// 항상 세션의 userId를 확인한다.
function requireUserId(req, res) {
  if (req.session && req.session.userId) return req.session.userId;
  res.status(401).json({ error: '로그인이 필요합니다.' });
  return null;
}

app.get('/api/favorites', requireApiAuth, async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const { rows } = await getPool().query(
    `SELECT primary_link AS link, name, addr, price, thumbnail, links_json AS links, created_at AS "createdAt"
     FROM favorites WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId]
  );
  res.json({ items: rows });
});

app.post('/api/favorites', requireApiAuth, async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const { link, name, addr, price, thumbnail, links } = req.body || {};
  if (!link || typeof link !== 'string') {
    return res.status(400).json({ error: 'link가 필요합니다.' });
  }
  const linksJson = Array.isArray(links) && links.length ? links : [{ platform: null, link, price: price ?? null }];
  await getPool().query(
    `INSERT INTO favorites (user_id, primary_link, name, addr, price, thumbnail, links_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, primary_link)
     DO UPDATE SET name = EXCLUDED.name, addr = EXCLUDED.addr, price = EXCLUDED.price,
       thumbnail = EXCLUDED.thumbnail, links_json = EXCLUDED.links_json`,
    [userId, link, name || null, addr || null, price ?? null, thumbnail || null, JSON.stringify(linksJson)]
  );
  res.json({ ok: true });
});

app.delete('/api/favorites', requireApiAuth, async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const { link } = req.body || {};
  if (!link || typeof link !== 'string') {
    return res.status(400).json({ error: 'link가 필요합니다.' });
  }
  await getPool().query('DELETE FROM favorites WHERE user_id = $1 AND primary_link = $2', [userId, link]);
  res.json({ ok: true });
});

// 즐겨찾기 목록에서 날짜를 고르면 저장 당시 스냅샷이 아니라 그 날짜 기준 실시간 잔여석/가격을
// 보여준다. 즐겨찾기엔 우리 쪽 고정 캠핑장 ID가 없어서, 저장해둔 주소(시/도, 시/군/구)와 이름으로
// 그 플랫폼만 다시 검색해 저장된 링크와 정확히 일치하는 항목을 찾는 방식으로 조회한다.
// 캠핏/네이버는 Playwright 페이지 하나를 공유하기 때문에(searchCamfit/searchNaver 내부) 즐겨찾기
// 여러 개를 동시에(Promise.all) 조회하면 같은 페이지를 두고 서로 충돌할 수 있어 순서대로 처리한다.
app.post('/api/favorites/availability', requireApiAuth, async (req, res) => {
  const userId = requireUserId(req, res);
  if (!userId) return;
  const { checkin, checkout } = req.body || {};
  if (!checkin || !checkout) {
    return res.status(400).json({ error: 'checkin/checkout가 필요합니다.' });
  }

  const { rows } = await getPool().query(
    'SELECT primary_link, name, addr, links_json FROM favorites WHERE user_id = $1',
    [userId]
  );

  const results = [];
  for (const fav of rows) {
    const tokens = (fav.addr || '').trim().split(/\s+/).filter(Boolean);
    const sido = tokens[0] || '';
    const sigungu = tokens[1] || '';
    const links = fav.links_json || [];
    const platforms = new Set(links.map((l) => l.platform).filter(Boolean));
    const linkByCleanLink = new Map(links.map((l) => [stripDateParams(l.link), l.link]));

    let items = [];
    try {
      if (platforms.has('땡큐캠핑')) {
        items.push(...await searchThankQ({ sido, sigungu, checkin, checkout, adults: 2, siteType: '' }));
      }
    } catch (e) { /* 한 플랫폼 실패가 나머지 즐겨찾기 조회를 막지 않게 조용히 넘어간다 */ }
    try {
      if (platforms.has('캠핏')) {
        items.push(...await searchCamfit({ sido, sigungu, adults: 2, hasNameOrFilter: true, filterKeys: [] }));
      }
    } catch (e) { /* 위와 동일 */ }
    try {
      if (platforms.has('네이버')) {
        items.push(...await searchNaver({ sido, sigungu, keyword: fav.name, checkin, checkout }));
      }
    } catch (e) { /* 위와 동일 */ }

    // 응답의 link는 방금 검색한(날짜가 붙을 수 있는) 링크가 아니라 저장해둔 원래 링크로 돌려준다 -
    // 즐겨찾기 페이지가 저장된 링크를 키로 이 결과를 찾아 매칭하기 때문이다.
    const byPlatform = [];
    items.forEach((i) => {
      const storedLink = linkByCleanLink.get(stripDateParams(i.link));
      if (!storedLink) return;
      byPlatform.push({
        platform: i.platform,
        link: storedLink,
        price: i.price,
        totalSites: i.totalSites,
        availableSites: i.availableSites,
      });
    });
    results.push({ link: fav.primary_link, byPlatform });
  }

  res.json({ items: results });
});

app.get('/api/search', requireApiAuth, async (req, res) => {
  const { sido, sigungu, adults, siteType } = req.query;
  const keyword = (req.query.keyword || '').trim();
  const filterKeys = (req.query.filters || '').split(',').map((s) => s.trim()).filter(Boolean);
  const hasNameOrFilter = Boolean(keyword) || filterKeys.length > 0;
  const onlyAvailable = req.query.onlyAvailable === 'true';
  const wantsMap = req.query.map === 'true';
  // 날짜는 필수가 아니다 - 캠핑장을 먼저 둘러보고 나중에 날짜를 골라 빈자리를 확인하고 싶다는
  // 요청이 있어, 안 고르면 예전처럼 "내일"로 슬쩍 채우지 않고 그대로 빈 채로 검색한다(땡큐캠핑은
  // 날짜 없이도 정상 응답하는 것을 확인함).
  const checkin = req.query.checkin ? fmtDate(new Date(req.query.checkin)) : '';
  const checkout = req.query.checkout ? fmtDate(new Date(req.query.checkout)) : '';

  // 플랫폼 필터가 비어있으면(기본값) 전체 검색 - 특정 플랫폼만 고르면 나머지는 아예 요청하지 않아서
  // (느린 캠핏/네이버를 뺄 수 있으면) 더 빨라지기도 한다.
  const platformFilter = (req.query.platforms || '').split(',').map((s) => s.trim()).filter(Boolean);
  const wantsPlatform = (name) => platformFilter.length === 0 || platformFilter.includes(name);

  const [thankqResult, camfitResult, naverResult] = await Promise.allSettled([
    wantsPlatform('땡큐캠핑')
      ? searchThankQ({ sido, sigungu, checkin, checkout, adults: Number(adults) || 2, siteType })
      : Promise.resolve([]),
    wantsPlatform('캠핏')
      ? searchCamfit({ sido, sigungu, adults: Number(adults) || 2, hasNameOrFilter, filterKeys })
      : Promise.resolve([]),
    wantsPlatform('네이버')
      ? searchNaver({ sido, sigungu, keyword, checkin, checkout })
      : Promise.resolve([]),
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

  // 네이버 지도는 캠핏/땡큐캠핑과 달리 진짜 전국검색(위치 필터)이 없어서, 지역/검색어가 전부
  // 비어있으면 네이버 자체 기본 노출 순서로 상위 일부만 보여준다 - 왜 개수가 적은지 알 수 있게
  // 안내를 붙인다.
  if (wantsPlatform('네이버') && !sido && !sigungu && !keyword) {
    notices.push('네이버는 지역/검색어를 지정하지 않으면 네이버 자체 기본 노출 순서로 일부 결과만 보여드려요. 더 폭넓게 보려면 지역을 선택해보세요.');
  }

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
