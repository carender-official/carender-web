const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const { addMonthsClamped } = require('./_lib/billing-date')

// 플랜 정식 키: 'standard' | 'pro'  ('premium' 은 구 키 → 'pro' 로 정규화)
const PLAN_KEYS = ['standard', 'pro']
const PLAN_BY_AMOUNT = { 1900: 'standard', 2900: 'pro' }
function resolvePlanKey(raw) {
  if (!raw) return null
  const k = String(raw).toLowerCase()
  if (k === 'premium') return 'pro'             // 레거시 별칭 수렴
  return PLAN_KEYS.includes(k) ? k : null
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, CORS_HEADERS)
    res.end()
    return
  }

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

  const { imp_uid, merchant_uid } = body
  console.log('[webhook] 수신 — imp_uid:', imp_uid, '/ merchant_uid:', merchant_uid)

  if (!imp_uid) {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'imp_uid required' }))
    return
  }

  // ── 2. 포트원 인증 토큰 발급 ────────────────────────────────────
  console.log('[webhook] 포트원 토큰 발급 요청')
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
      console.error('[webhook] 토큰 발급 실패 — code:', tokenData.code)
      res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'PortOne token error' }))
      return
    }
    accessToken = tokenData.response.access_token
    console.log('[webhook] 포트원 토큰 발급 성공')
  } catch (e) {
    console.error('[webhook] 토큰 발급 예외:', e.message)
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'PortOne token fetch failed' }))
    return
  }

  // ── 3. imp_uid로 결제 정보 조회 → customer_uid 추출 ─────────────
  console.log('[webhook] 결제 정보 조회 — imp_uid:', imp_uid)
  let customerUid
  let planKey = null
  try {
    const payRes  = await fetch(`https://api.iamport.kr/payments/${encodeURIComponent(imp_uid)}`, {
      headers: { Authorization: accessToken },
    })
    const payData = await payRes.json()
    if (payData.code !== 0 || !payData.response) {
      console.warn('[webhook] 결제 조회 실패 — code:', payData.code)
      res.writeHead(402, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Payment not found' }))
      return
    }
    customerUid = payData.response.customer_uid
    console.log('[webhook] customer_uid 확인:', customerUid)

    // 플랜 식별: 검증된 실제 청구금액(amount)이 1차. tier_code 는 교차검증용으로만 사용.
    let tierFromCustom = null
    try {
      const cd = typeof payData.response.custom_data === 'string'
        ? JSON.parse(payData.response.custom_data)
        : payData.response.custom_data
      tierFromCustom = cd && cd.tier_code ? cd.tier_code : null
    } catch { tierFromCustom = null }

    const planFromAmount = PLAN_BY_AMOUNT[payData.response.amount] || null
    const planFromCustom = resolvePlanKey(tierFromCustom)
    if (!planFromAmount) {
      // 1900/2900 어느 쪽도 아님 → 알 수 없는 결제. profiles 를 전혀 건드리지 않고
      // (status/next_billing_date 포함 어떤 필드도 미기록) 경고만 남긴 뒤 200 으로 종료한다.
      // 200 인 이유: 포트원이 webhook 실패로 간주해 재전송하는 것을 막기 위함.
      console.warn('[webhook] 알 수 없는 결제금액 — profiles 미반영 / imp_uid:', imp_uid,
        '/ customer_uid:', customerUid, '/ amount:', payData.response.amount, '/ tier_code:', tierFromCustom)
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, skipped: 'unknown_amount' }))
      return
    } else {
      // 금액 기준으로 기록. tier_code 가 어긋나면 금액을 신뢰하고 조작 의심 흔적을 남긴다.
      planKey = planFromAmount
      if (planFromCustom && planFromCustom !== planFromAmount) {
        console.warn('[webhook] 플랜 불일치(조작 의심) — 금액:', planFromAmount, '/ tier_code:', planFromCustom,
          '→ 금액 기준 기록 / customer_uid:', customerUid, '/ imp_uid:', imp_uid)
      } else {
        console.log('[webhook] plan 식별(금액 기준):', planKey, '(tier_code:', planFromCustom, ')')
      }
    }
  } catch (e) {
    console.error('[webhook] 결제 조회 예외:', e.message)
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Payment fetch failed' }))
    return
  }

  if (!customerUid) {
    console.warn('[webhook] customer_uid 없음 — 빌링키 발급 건 아닌 것으로 판단')
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, skipped: true }))
    return
  }

  // ── 4. 빌링키 존재 여부 검증 ────────────────────────────────────
  console.log('[webhook] 빌링키 검증 — customer_uid:', customerUid)
  try {
    const billingRes  = await fetch(
      `https://api.iamport.kr/subscribe/customers/${encodeURIComponent(customerUid)}`,
      { headers: { Authorization: accessToken } }
    )
    const billingData = await billingRes.json()
    if (billingData.code !== 0 || !billingData.response?.customer_uid) {
      console.warn('[webhook] 빌링키 없음 — code:', billingData.code)
      res.writeHead(402, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Billing key not found' }))
      return
    }
    console.log('[webhook] 빌링키 검증 성공')
  } catch (e) {
    console.error('[webhook] 빌링키 검증 예외:', e.message)
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Billing key fetch failed' }))
    return
  }

  // ── 5. user_id 추출 (customer_uid = 'customer_' + user.id) ──────
  const userId = customerUid.replace(/^customer_/, '')
  if (!userId) {
    console.error('[webhook] user_id 추출 실패 — customer_uid 형식 불일치:', customerUid)
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Cannot derive user_id' }))
    return
  }

  // ── 6. Supabase profiles 업데이트 ───────────────────────────────
  const now             = new Date()
  const nextBillingDate = addMonthsClamped(now, 1)

  console.log('[webhook] Supabase 업데이트 — user_id:', userId)
  try {
    const supabaseUrl = process.env.SUPABASE_URL
    const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY

    const sbRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        headers: {
          'apikey':        serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type':  'application/json',
          'Prefer':        'return=representation',
        },
        body: JSON.stringify({
          customer_uid:        customerUid,
          billing_key:         customerUid,
          subscription_status: 'active',
          // planKey 가 null(알 수 없는 결제)이면 plan 미기록 — 기존 plan 값을 덮어쓰지 않는다.
          ...(planKey ? { plan: planKey } : {}),
          is_trial:            false,
          last_payment_at:     now.toISOString(),
          next_billing_date:   nextBillingDate.toISOString(),
        }),
      }
    )

    if (!sbRes.ok) {
      const errText = await sbRes.text()
      console.error('[webhook] Supabase 실패 — status:', sbRes.status, '/', errText)
      res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Supabase update failed' }))
      return
    }

    console.log('[webhook] Supabase 업데이트 성공 — user_id:', userId)
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  } catch (e) {
    console.error('[webhook] Supabase 예외:', e.message)
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Supabase fetch failed' }))
  }
}
