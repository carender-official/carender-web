const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

// 플랜 정식 키: 'standard' | 'pro'  ('premium' 은 구 키 → 'pro' 로 정규화)
const PLAN_KEYS = ['standard', 'pro']
function resolvePlanKey(raw) {
  if (!raw) return null
  const k = String(raw).toLowerCase()
  if (k === 'premium') return 'pro'             // 레거시 별칭 수렴
  return PLAN_KEYS.includes(k) ? k : null
}

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

  // 플랜 식별: 결제 요청에 명시적으로 실린 식별자(tier_code/plan)를 사용.
  // billing.js 는 빌링키 발급 확인 요청이라 청구 금액이 없어 금액 이중 체크 불가 →
  // 식별자가 없으면 plan 을 쓰지 않고 webhook(금액 기반)에 위임한다.
  const planKey = resolvePlanKey(tier_code || plan)

  if (!customer_uid || !user_id) {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'customer_uid and user_id are required' }))
    return
  }

  console.log('[billing] 요청 수신 — user_id:', user_id, '/ customer_uid:', customer_uid)

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
  let billingData
  try {
    const billingRes = await fetch(
      `https://api.iamport.kr/subscribe/customers/${encodeURIComponent(customer_uid)}`,
      { headers: { Authorization: accessToken } }
    )
    billingData = await billingRes.json()

    if (billingData.code !== 0 || !billingData.response?.customer_uid) {
      console.warn('[billing] 빌링키 검증 실패 — code:', billingData.code, '/ message:', billingData.message)
      res.writeHead(402, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Billing key not found or invalid' }))
      return
    }

    console.log('[billing] 빌링키 검증 성공 — customer_uid:', billingData.response.customer_uid)
  } catch (e) {
    console.error('[billing] 빌링키 조회 예외:', e.message)
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'PortOne billing key fetch failed' }))
    return
  }

  // ── 4. Supabase profiles 업데이트 ───────────────────────────────
  const now = new Date()
  const nextBillingDate = new Date(now)
  nextBillingDate.setDate(nextBillingDate.getDate() + 30)

  const patch = {
    customer_uid,
    billing_key:        billingData.response.customer_uid,
    subscription_status: 'active',
    is_trial:           false,
    last_payment_at:    now.toISOString(),
    next_billing_date:  nextBillingDate.toISOString(),
  }
  // 명시적 식별자가 있을 때만 plan 기록 (정식 키). 없으면 webhook 이 금액 기반으로 채움.
  if (planKey) {
    patch.plan = planKey
    console.log('[billing] plan 식별 — 명시적 식별자:', planKey)
  } else {
    console.log('[billing] plan 식별자 없음 — plan 미기록, webhook(금액 기반) 위임')
  }

  console.log('[billing] Supabase 업데이트 시작 — user_id:', user_id)
  try {
    const supabaseUrl = process.env.SUPABASE_URL
    const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY

    const sbRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user_id)}`,
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

    if (!sbRes.ok) {
      const errText = await sbRes.text()
      console.error('[billing] Supabase 업데이트 실패 — status:', sbRes.status, '/ body:', errText)
      res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Supabase update failed' }))
      return
    }

    console.log('[billing] Supabase 업데이트 성공 — user_id:', user_id)
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } catch (e) {
    console.error('[billing] Supabase 업데이트 예외:', e.message)
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Supabase fetch failed' }))
  }
}
