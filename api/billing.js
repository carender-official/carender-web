const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const { addMonthsClamped, seoulYmd } = require('./_lib/billing-date')
const { PLAN_PRICING, resolvePlanKey } = require('./_lib/plan-pricing')

module.exports = async (req, res) => {
  // OPTIONS 프리플라이트
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS_HEADERS)
    res.end()
    return
  }

  // POST 외 메서드 거부
  if (req.method !== 'POST') {
    res.writeHead(405, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }))
    return
  }

  // ── 1. body 파싱 ────────────────────────────────────────────────
  let body
  try {
    const raw = await new Promise((resolve, reject) => {
      let data = ''
      req.on('data', chunk => { data += chunk })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
    body = JSON.parse(raw)
  } catch {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Invalid JSON body' }))
    return
  }

  const { customer_uid, user_id, tier_code, plan } = body

  if (!customer_uid || !user_id) {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'customer_uid and user_id are required' }))
    return
  }

  // 플랜 결정: 즉시청구 단계라 금액(plan)이 필수 → 식별 실패 시 즉시 400.
  const planKey = resolvePlanKey(tier_code || plan)
  if (!planKey) {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Unknown or missing plan (tier_code/plan required)' }))
    return
  }

  console.log('[billing] 요청 수신 — user_id:', user_id, '/ customer_uid:', customer_uid, '/ plan:', planKey)

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY

  // ── 2. 포트원 인증 토큰 발급 ────────────────────────────────────
  console.log('[billing] 포트원 토큰 발급 요청')
  let accessToken
  try {
    const tokenRes = await fetch('https://api.iamport.kr/users/getToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imp_key:    process.env.PORTONE_API_KEY,
        imp_secret: process.env.PORTONE_API_SECRET,
      }),
    })
    const tokenData = await tokenRes.json()

    if (tokenData.code !== 0 || !tokenData.response?.access_token) {
      console.error('[billing] 포트원 토큰 발급 실패 — code:', tokenData.code, '/ message:', tokenData.message)
      res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'PortOne token error' }))
      return
    }

    accessToken = tokenData.response.access_token
    console.log('[billing] 포트원 토큰 발급 성공')
  } catch (e) {
    console.error('[billing] 포트원 토큰 발급 예외:', e.message)
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'PortOne token fetch failed' }))
    return
  }

  // ── 3. 빌링키 존재 여부 조회 ────────────────────────────────────
  console.log('[billing] 빌링키 조회 요청 — customer_uid:', customer_uid)
  let billingKey
  try {
    const billingRes = await fetch(
      `https://api.iamport.kr/subscribe/customers/${encodeURIComponent(customer_uid)}`,
      { headers: { Authorization: accessToken } }
    )
    const billingData = await billingRes.json()

    if (billingData.code !== 0 || !billingData.response?.customer_uid) {
      console.warn('[billing] 빌링키 검증 실패 — code:', billingData.code, '/ message:', billingData.message)
      res.writeHead(402, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Billing key not found or invalid' }))
      return
    }

    billingKey = billingData.response.customer_uid
    console.log('[billing] 빌링키 검증 성공 — customer_uid:', billingKey)
  } catch (e) {
    console.error('[billing] 빌링키 조회 예외:', e.message)
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'PortOne billing key fetch failed' }))
    return
  }

  // ── 4. 현재 유저 상태 조회 (is_trial / trial_end_date) ──────────
  let profile = null
  try {
    const pRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user_id)}&select=is_trial,trial_end_date,subscription_status,next_billing_date`,
      { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
    )
    if (!pRes.ok) {
      const errText = await pRes.text()
      console.error('[billing] 프로필 조회 실패 — status:', pRes.status, '/ body:', errText)
      res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Profile fetch failed' }))
      return
    }
    const rows = await pRes.json()
    profile = Array.isArray(rows) ? rows[0] : null
  } catch (e) {
    console.error('[billing] 프로필 조회 예외:', e.message)
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Profile fetch exception' }))
    return
  }

  // 조회는 성공했으나 해당 프로필 행이 없음(빈 배열) → 체험 여부를 알 수 없으므로
  // (가)/(나) 진입 전에 차단. 비체험으로 오인되어 즉시청구되는 것을 막는다.
  if (!profile) {
    console.warn('[billing] 프로필 없음 — 청구 차단 / user_id:', user_id)
    res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, charged: false, reason: 'profile_not_found' }))
    return
  }

  const now    = new Date()
  const isTrialActive =
    !!profile &&
    profile.is_trial === true &&
    profile.trial_end_date &&
    new Date(profile.trial_end_date) > now

  // ── 5-가. 체험 중 결제: 즉시청구 없이 체험 종료일에 첫 청구 예약 ──
  if (isTrialActive) {
    console.log('[billing] 체험 중 결제 — 즉시청구 안 함, trial_end 에 예약 / user_id:', user_id)
    const patch = {
      customer_uid,
      billing_key:         billingKey,
      pending_plan:        planKey,                    // 체험 종료 후 전환할 플랜 기록(plan 즉시변경 안 함 → pro 등급 유지)
      is_trial:            true,                       // 체험 유지
      subscription_status: 'active',
      next_billing_date:   profile.trial_end_date,     // 체험 종료일 = 첫 청구일
    }
    try {
      await patchProfile(supabaseUrl, serviceKey, user_id, patch)
    } catch (e) {
      console.error('[billing] 프로필 업데이트 실패(trial) — user_id:', user_id, '/', e.message)
      res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Supabase update failed' }))
      return
    }
    console.log('[billing] 체험 예약 완료 — user_id:', user_id, '/ next_billing_date:', patch.next_billing_date)
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, charged: false, reason: 'trial_scheduled' }))
    return
  }

  // ── 5-나 진입 전: 이미 유효한 유료 구독 중이면 즉시 재청구 안 함(중복결제 방어) ──
  // 비체험 + active + 다음 결제일이 아직 미래 = 당 주기 결제가 살아있음 → skip.
  // (환불/해지=canceled, 만료=expired, free, 체험중=is_trial 은 이 조건에서 빠져 정상적으로 (나)청구 허용)
  if (
    profile.subscription_status === 'active' &&
    profile.is_trial === false &&
    profile.next_billing_date && new Date(profile.next_billing_date) > now
  ) {
    console.log('[billing] 이미 유효 구독 중 — 즉시청구 skip / user_id:', user_id)
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, charged: false, skipped: true, reason: 'already_subscribed' }))
    return
  }

  // ── 5-나. 비체험 / 체험만료 업그레이드: 즉시 1회 청구 ───────────
  const pricing     = PLAN_PRICING[planKey]
  const merchantUid = `first_${user_id}_${seoulYmd(now)}`
  console.log('[billing] 즉시청구 시도 — user_id:', user_id, '/ amount:', pricing.amount, '/ merchant_uid:', merchantUid)

  let paid = false
  let failMsg = '알 수 없는 결제 오류'
  let lastImpUid = null   // payData 는 try 블록 const 스코프 → patch 에서 못 봄. imp_uid 만 외부 변수로 끌어올림.
  try {
    const payRes = await fetch('https://api.iamport.kr/subscribe/payments/again', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: accessToken },
      body: JSON.stringify({
        customer_uid,
        merchant_uid: merchantUid,
        amount:       pricing.amount,
        name:         pricing.name,
      }),
    })
    const payData = await payRes.json()
    paid = payData.code === 0 && payData.response && payData.response.status === 'paid'
    lastImpUid = (payData && payData.response && payData.response.imp_uid) || null
    if (!paid) {
      failMsg = payData.response?.fail_reason || payData.message || failMsg
      console.warn('[billing] 즉시청구 실패 — user_id:', user_id,
        '/ code:', payData.code, '/ status:', payData.response?.status, '/ msg:', failMsg)
      // 8128(신용카드 중복거래) 거부만 사용자 친화 문구로 치환. 로그(위)엔 원문 보존.
      // 다른 거부 사유(한도초과·정지카드 등)는 fail_reason 원문 그대로 유지.
      if (typeof failMsg === 'string' && (failMsg.includes('중복거래') || failMsg.includes('8128'))) {
        failMsg = '플랜 변경은 결제 다음 날부터 가능해요. 내일 다시 시도해 주세요.'
      }
    }
  } catch (e) {
    console.error('[billing] 즉시청구 예외 — user_id:', user_id, '/', e.message)
    failMsg = e.message || failMsg
    paid = false
  }

  if (paid) {
    const patch = {
      customer_uid,
      billing_key:         billingKey,
      plan:                planKey,
      is_trial:            false,
      subscription_status: 'active',
      last_payment_at:     now.toISOString(),
      next_billing_date:   addMonthsClamped(now, 1).toISOString(),
      service_used_at:     null,
      last_imp_uid:        lastImpUid,
    }
    try {
      await patchProfile(supabaseUrl, serviceKey, user_id, patch)
    } catch (e) {
      console.error('[billing] 프로필 업데이트 실패(paid) — user_id:', user_id, '/', e.message)
      res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Supabase update failed' }))
      return
    }
    console.log('[billing] 즉시청구 성공 — user_id:', user_id, '/ next_billing_date:', patch.next_billing_date)
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, charged: true }))
    return
  }

  // 청구 실패: 빌링키만 보관(plan/status 미상향). 사용자는 재시도 가능.
  try {
    await patchProfile(supabaseUrl, serviceKey, user_id, { customer_uid, billing_key: billingKey })
  } catch (e) {
    console.error('[billing] 프로필 업데이트 실패(fail) — user_id:', user_id, '/', e.message)
  }
  res.writeHead(402, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: false, charged: false, reason: failMsg }))
}

async function patchProfile(supabaseUrl, serviceKey, userId, patch) {
  const r = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: {
        'apikey':        serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type':  'application/json',
        'Prefer':        'return=representation',
      },
      body: JSON.stringify(patch),
    }
  )
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Supabase PATCH ${r.status}: ${t}`)
  }
}
