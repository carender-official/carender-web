// 7일 이내 미사용 청약철회 환불 엔드포인트.
// POST { user_id }
// - 서버에서 환불 대상(7일 이내 + 미사용)을 재확인하고,
//   같은 달 + last_imp_uid 있으면 PortOne payments/cancel 로 즉시 자동환불,
//   월 경계 또는 imp_uid 없으면 refund_requests 에 pending 으로 적재(수동 처리).
// - 어느 경로든 profiles 는 plan='free', subscription_status='canceled' 로 강등.
// 구조(CORS/토큰/supabase REST)는 billing.js 패턴을 그대로 따른다.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

const { seoulYmd } = require('./_lib/billing-date')
const { PLAN_PRICING, resolvePlanKey } = require('./_lib/plan-pricing')

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

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

  const { user_id } = body
  if (!user_id) {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'user_id required' }))
    return
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) {
    res.writeHead(500, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Missing Supabase env' }))
    return
  }
  const sbHeaders = {
    'apikey':        serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type':  'application/json',
  }

  // 작은 헬퍼들 ----------------------------------------------------
  const fail = (code, msg) => {
    res.writeHead(code, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: msg }))
  }
  async function insertRefundRequest(row) {
    const r = await fetch(`${supabaseUrl}/rest/v1/refund_requests`, {
      method: 'POST',
      headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
      body: JSON.stringify(row),
    })
    if (!r.ok) {
      const t = await r.text()
      throw new Error(`refund_requests insert ${r.status}: ${t}`)
    }
  }
  async function downgradeProfile() {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user_id)}`,
      {
        method: 'PATCH',
        headers: { ...sbHeaders, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ plan: 'free', subscription_status: 'canceled' }),
      }
    )
    if (!r.ok) {
      const t = await r.text()
      throw new Error(`profiles patch ${r.status}: ${t}`)
    }
  }

  // ── 2. 프로필 단건 조회 ─────────────────────────────────────────
  let profile = null
  try {
    const pRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(user_id)}`
        + `&select=id,plan,customer_uid,last_payment_at,last_imp_uid,service_used_at,subscription_status`,
      { headers: sbHeaders }
    )
    if (!pRes.ok) {
      const t = await pRes.text()
      console.error('[refund] 프로필 조회 실패 — status:', pRes.status, '/', t)
      return fail(500, 'Profile fetch failed')
    }
    const rows = await pRes.json()
    profile = Array.isArray(rows) ? rows[0] : null
  } catch (e) {
    console.error('[refund] 프로필 조회 예외:', e.message)
    return fail(500, 'Profile fetch exception')
  }
  if (!profile) return fail(404, '프로필을 찾을 수 없어요.')

  // ── 3. 환불 대상 판정(서버 재확인) ──────────────────────────────
  const now = new Date()
  if (!profile.last_payment_at) return fail(400, '결제 내역 없음')
  const paidAt = new Date(profile.last_payment_at)
  if (Number.isNaN(paidAt.getTime())) return fail(400, '결제 내역 없음')
  if (now.getTime() - paidAt.getTime() > SEVEN_DAYS_MS) return fail(400, '환불 가능 기간 경과')
  if (profile.service_used_at != null) return fail(400, '이미 서비스 이용함')

  // ── 6. 금액 결정 (plan-pricing 재사용) ──────────────────────────
  const planKey = resolvePlanKey(profile.plan)          // premium → pro 수렴
  const pricing = planKey ? PLAN_PRICING[planKey] : null
  if (!pricing) return fail(400, '환불 금액을 결정할 수 없어요(플랜).')
  const amount = pricing.amount

  // ── 정책: 환불 대상이면 환불 성공/실패·skip 과 무관하게 즉시 무료 전환(환불은 후속). ──
  //   payments/cancel 시도 전에 1회만 강등한다. 전환 자체가 실패하면 환불 진행 의미 없어 500.
  try {
    await downgradeProfile()
  } catch (e) {
    console.error('[refund] 무료 전환 실패 — user_id:', user_id, '/', e.message)
    return fail(500, 'Downgrade failed')
  }

  // ── 4. 중복 가드: 이번 결제건(last_imp_uid)이 이미 done(환불 완료)이면 환불만 skip ─────
  //   pending 은 재시도 허용(더 이상 dedup 대상 아님). last_imp_uid 없으면 매칭 불가 → dedup skip.
  //   무료 전환은 위에서 이미 끝났으므로 여기선 환불(payments/cancel)만 건너뛴다.
  if (profile.last_imp_uid) {
    try {
      const dupRes = await fetch(
        `${supabaseUrl}/rest/v1/refund_requests?user_id=eq.${encodeURIComponent(user_id)}`
          + `&status=eq.done&imp_uid=eq.${encodeURIComponent(profile.last_imp_uid)}&select=id&limit=1`,
        { headers: sbHeaders }
      )
      if (dupRes.ok) {
        const dupRows = await dupRes.json()
        if (Array.isArray(dupRows) && dupRows.length > 0) {
          res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, accepted: true, already: true }))
          return
        }
      } else {
        const t = await dupRes.text()
        console.error('[refund] 중복 조회 실패 — status:', dupRes.status, '/', t)
        return fail(500, 'Refund dedup check failed')
      }
    } catch (e) {
      console.error('[refund] 중복 조회 예외:', e.message)
      return fail(500, 'Refund dedup exception')
    }
  }

  // ── 5. 월경계 판정 (KST 'YYYYMM' 비교) ──────────────────────────
  const isCrossMonth = seoulYmd(paidAt).slice(0, 6) !== seoulYmd(now).slice(0, 6)
  const impUid = profile.last_imp_uid || null
  const customerUid = profile.customer_uid || null

  // ── 7-A. 같은 달 + imp_uid 있음 → 자동환불 시도 ────────────────
  if (!isCrossMonth && impUid) {
    // 토큰 발급(billing.js 패턴 그대로)
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
        console.error('[refund] 포트원 토큰 발급 실패 — code:', tokenData.code, '/ message:', tokenData.message)
        // 무료 전환은 이미 끝남 → 환불만 pending 으로 적재하고 200(후속 수동 처리).
        try {
          await insertRefundRequest({
            user_id,
            status:         'pending',
            auto_refunded:  false,
            is_cross_month: false,
            error_msg:      'PortOne 토큰 실패',
            imp_uid:        impUid,
            merchant_uid:   null,
            amount,
            customer_uid:   customerUid,
            plan:           planKey,
            paid_at:        profile.last_payment_at,
          })
        } catch (e2) {
          console.error('[refund] pending 적재 실패(토큰 실패분) — user_id:', user_id, '/', e2.message)
          return fail(500, 'Refund pending record failed')
        }
        res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, accepted: true }))
        return
      }
      accessToken = tokenData.response.access_token
    } catch (e) {
      console.error('[refund] 포트원 토큰 발급 예외:', e.message)
      // 무료 전환은 이미 끝남 → 환불만 pending 으로 적재하고 200(후속 수동 처리).
      try {
        await insertRefundRequest({
          user_id,
          status:         'pending',
          auto_refunded:  false,
          is_cross_month: false,
          error_msg:      'PortOne 토큰 예외: ' + (e.message || ''),
          imp_uid:        impUid,
          merchant_uid:   null,
          amount,
          customer_uid:   customerUid,
          plan:           planKey,
          paid_at:        profile.last_payment_at,
        })
      } catch (e2) {
        console.error('[refund] pending 적재 실패(토큰 예외분) — user_id:', user_id, '/', e2.message)
        return fail(500, 'Refund pending record failed')
      }
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, accepted: true }))
      return
    }

    // payments/cancel 호출
    let cancelled = false
    let cancelMsg = '알 수 없는 환불 오류'
    try {
      const cancelRes = await fetch('https://api.iamport.kr/payments/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: accessToken },
        body: JSON.stringify({
          imp_uid:  impUid,
          amount:   amount,
          checksum: amount,
          reason:   '7일 이내 미사용 청약철회',
        }),
      })
      const cancelData = await cancelRes.json()
      cancelled = cancelData.code === 0 && !!cancelData.response
      if (!cancelled) {
        cancelMsg = cancelData.message || cancelMsg
        console.warn('[refund] 환불 실패 — user_id:', user_id, '/ code:', cancelData.code, '/ msg:', cancelMsg)
      }
    } catch (e) {
      console.error('[refund] payments/cancel 예외 — user_id:', user_id, '/', e.message)
      cancelMsg = e.message || cancelMsg
      cancelled = false
    }

    if (cancelled) {
      try {
        await insertRefundRequest({
          user_id,
          status:         'done',
          auto_refunded:  true,
          is_cross_month: false,
          imp_uid:        impUid,
          merchant_uid:   null,
          amount,
          customer_uid:   customerUid,
          plan:           planKey,
          paid_at:        profile.last_payment_at,
          processed_at:   now.toISOString(),
        })
      } catch (e) {
        console.error('[refund] 환불 성공 후 기록 실패 — user_id:', user_id, '/', e.message)
        return fail(500, 'Refund recorded-but-update failed')
      }
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, accepted: true }))
      return
    }

    // 자동환불 실패 → pending 적재 + 강등(수동 처리 위임)
    try {
      await insertRefundRequest({
        user_id,
        status:         'pending',
        auto_refunded:  false,
        is_cross_month: false,
        error_msg:      cancelMsg,
        imp_uid:        impUid,
        merchant_uid:   null,
        amount,
        customer_uid:   customerUid,
        plan:           planKey,
        paid_at:        profile.last_payment_at,
      })
    } catch (e) {
      console.error('[refund] pending 적재 실패(자동환불 실패분) — user_id:', user_id, '/', e.message)
      return fail(500, 'Refund pending record failed')
    }
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, accepted: true }))
    return
  }

  // ── 7-B. 월 경계 또는 imp_uid 없음 → 자동환불 안 함, pending 적재 ─
  try {
    await insertRefundRequest({
      user_id,
      status:         'pending',
      auto_refunded:  false,
      is_cross_month: isCrossMonth,
      error_msg:      impUid ? '월 경계 — 수동 처리' : 'imp_uid 없음',
      imp_uid:        impUid,        // null 가능
      merchant_uid:   null,
      amount,
      customer_uid:   customerUid,
      plan:           planKey,
      paid_at:        profile.last_payment_at,
    })
  } catch (e) {
    console.error('[refund] pending 적재 실패(월경계/무imp_uid) — user_id:', user_id, '/', e.message)
    return fail(500, 'Refund pending record failed')
  }
  res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, accepted: true }))
}
