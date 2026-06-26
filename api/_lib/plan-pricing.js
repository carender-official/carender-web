// 플랜 가격/키 단일 정의 — billing.js, renew.js 공용. 중복정의 금지.
// 정식 키: 'standard' | 'pro'  ('premium' 은 구 키 → 'pro' 로 정규화)
// 월 구독만 가격이 정의돼 있음(연간 상품/가격은 제품에 아직 없음).
const PLAN_PRICING = {
  standard: { amount: 1900, name: '캐린더 스탠다드 월 구독' },
  pro:      { amount: 2900, name: '캐린더 프리미엄 월 구독' },
}
function resolvePlanKey(raw) {
  if (!raw) return null
  const k = String(raw).toLowerCase()
  if (k === 'premium') return 'pro'             // 레거시 별칭 수렴
  return PLAN_PRICING[k] ? k : null
}
module.exports = { PLAN_PRICING, resolvePlanKey }
