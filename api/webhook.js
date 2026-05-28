const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
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
  const nextBillingDate = new Date(now)
  nextBillingDate.setDate(nextBillingDate.getDate() + 30)

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
          plan:                'premium',
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
