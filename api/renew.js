// 정기결제 자동갱신 스케줄러 (Vercel Cron → 매일 1회)
// 청구 대상: subscription_status IN ('active','past_due') AND next_billing_date <= now()
// canceled / expired 는 어떤 경우에도 청구 대상에서 제외된다.

const JSON_HEADERS = { 'Content-Type': 'application/json' }

// ── 플랜 매핑 ────────────────────────────────────────────────────
// 정식 키: 'standard' | 'pro'  ('premium' 은 구 키 → 'pro' 로 정규화)
// 월 구독만 가격이 정의돼 있음. 연간 상품/가격은 제품에 아직 없으므로 'year' 는 가격 미정 → 스킵.
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

const MAX_RETRY = 3   // billing_retry_count 가 이 값을 "초과"하면 다운그레이드

// 같은 날 cron 이 중복 실행돼도 동일 merchant_uid 로 PortOne 가 이중 결제를 막도록
// Asia/Seoul 기준 날짜(YYYYMMDD)로 결정적 생성. 익일 재시도는 자연히 새 uid 가 된다.
// (서버 타임존과 무관하게 항상 KST 날짜를 쓴다.)
function seoulYmd(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date).replace(/-/g, '')
}

// 기존 next_billing_date 를 앵커로 다음 주기 계산 (now() 기준 아님 → 무료 구간 누적 방지)
function extendFromAnchor(anchorIso, interval) {
  const d = new Date(anchorIso)
  if (interval === 'year') d.setFullYear(d.getFullYear() + 1)
  else d.setMonth(d.getMonth() + 1)
  return d.toISOString()
}

module.exports = async (req, res) => {
  // ── 1. Vercel cron 호출 검증 ──────────────────────────────────
  // CRON_SECRET 이 설정되면 Vercel 은 cron 호출에 Authorization: Bearer <CRON_SECRET> 를 실어 보낸다.
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) {
    res.writeHead(401, JSON_HEADERS)
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
    return
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey || !process.env.PORTONE_API_KEY || !process.env.PORTONE_API_SECRET) {
    res.writeHead(500, JSON_HEADERS)
    res.end(JSON.stringify({ ok: false, error: 'Missing required env' }))
    return
  }

  const sbHeaders = {
    'apikey':        serviceKey,
    'Authorization': `Bearer ${serviceKey}`,
    'Content-Type':  'application/json',
  }

  // ── 2. PortOne 액세스 토큰 발급 (billing.js/webhook.js 와 동일 방식) ──
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
      console.error('[renew] 포트원 토큰 발급 실패 — code:', tokenData.code)
      res.writeHead(500, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: 'PortOne token error' }))
      return
    }
    accessToken = tokenData.response.access_token
  } catch (e) {
    console.error('[renew] 포트원 토큰 발급 예외:', e.message)
    res.writeHead(500, JSON_HEADERS)
    res.end(JSON.stringify({ ok: false, error: 'PortOne token fetch failed' }))
    return
  }

  // ── 3. 청구 대상 조회 ─────────────────────────────────────────
  // 절대시각(UTC ISO) 그대로 비교. KST 변환을 끼워넣지 않는다.
  // in.(active,past_due) 필터로 canceled/expired 는 원천 제외된다.
  const nowIso = new Date().toISOString()
  let targets
  try {
    const q = `${supabaseUrl}/rest/v1/profiles`
      + `?select=*`
      + `&subscription_status=in.(active,past_due)`
      + `&next_billing_date=lte.${encodeURIComponent(nowIso)}`
    const r = await fetch(q, { headers: sbHeaders })
    if (!r.ok) {
      const t = await r.text()
      console.error('[renew] 대상 조회 실패 — status:', r.status, '/', t)
      res.writeHead(500, JSON_HEADERS)
      res.end(JSON.stringify({ ok: false, error: 'Target query failed' }))
      return
    }
    targets = await r.json()
  } catch (e) {
    console.error('[renew] 대상 조회 예외:', e.message)
    res.writeHead(500, JSON_HEADERS)
    res.end(JSON.stringify({ ok: false, error: 'Target query exception' }))
    return
  }

  console.log('[renew] 청구 대상:', targets.length, '건 / 기준시각:', nowIso)

  const result = {
    ok: true,
    now: nowIso,
    target_count: targets.length,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    downgraded: 0,
    details: [],
  }

  // ── 4. 대상별 재청구 (순차 처리) ──────────────────────────────
  for (const row of targets) {
    const userId = row.id
    const customerUid = row.customer_uid
    const interval = row.billing_interval || 'month'   // 컬럼 없으면 월 구독으로 간주
    const planKey = resolvePlanKey(row.plan)

    // 안전장치: 이중으로 canceled/expired 제외 (조회 필터로 이미 제외되지만 명시적으로 한 번 더)
    if (row.subscription_status === 'canceled' || row.subscription_status === 'expired') {
      result.skipped++
      result.details.push({ userId, skip: 'status_excluded', status: row.subscription_status })
      continue
    }
    if (!customerUid) {
      result.skipped++
      result.details.push({ userId, skip: 'no_customer_uid' })
      continue
    }
    if (!planKey) {
      result.skipped++
      result.details.push({ userId, skip: 'unmapped_plan', plan: row.plan })
      continue
    }
    if (interval === 'year') {
      // 연간 가격이 아직 정의돼 있지 않음 → 잘못된 금액 청구 방지 위해 스킵
      result.skipped++
      result.details.push({ userId, skip: 'no_yearly_price', plan: planKey })
      continue
    }

    const pricing = PLAN_PRICING[planKey]
    const merchantUid = `renew_${userId}_${seoulYmd(new Date())}`

    // ── 4-1. PortOne V1 재청구 ──────────────────────────────────
    let paid = false
    try {
      const payRes = await fetch('https://api.iamport.kr/subscribe/payments/again', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: accessToken },
        body: JSON.stringify({
          customer_uid: customerUid,
          merchant_uid: merchantUid,
          amount:       pricing.amount,
          name:         pricing.name,
        }),
      })
      const payData = await payRes.json()
      paid = payData.code === 0 && payData.response && payData.response.status === 'paid'
      if (!paid) {
        console.warn('[renew] 결제 실패 — userId:', userId,
          '/ code:', payData.code, '/ status:', payData.response?.status, '/ msg:', payData.message)
      }
    } catch (e) {
      console.error('[renew] 재청구 예외 — userId:', userId, '/', e.message)
      paid = false
    }

    // ── 4-2. 결과 반영 ─────────────────────────────────────────
    try {
      if (paid) {
        // 성공: 주기 앵커 유지(+1개월/+1년), active, 재시도 카운트 리셋, 정식 키로 수렴 기록
        const patch = {
          subscription_status: 'active',
          plan:                planKey,                                  // premium → pro 수렴
          next_billing_date:   extendFromAnchor(row.next_billing_date, interval),
          last_payment_at:     nowIso,
          billing_retry_count: 0,
        }
        await patchProfile(supabaseUrl, sbHeaders, userId, patch)
        result.succeeded++
        result.details.push({ userId, ok: true, plan: planKey, merchant_uid: merchantUid, next: patch.next_billing_date })
      } else {
        // 실패: 재시도 카운트 +1, 3회 초과 시 free/expired 다운그레이드 후 청구 중단
        const nextCount = (row.billing_retry_count || 0) + 1
        let patch
        if (nextCount > MAX_RETRY) {
          patch = { subscription_status: 'expired', plan: 'free', billing_retry_count: nextCount }
          result.downgraded++
          result.details.push({ userId, downgraded: true, retry: nextCount })
        } else {
          patch = { subscription_status: 'past_due', billing_retry_count: nextCount }
          result.failed++
          result.details.push({ userId, failed: true, retry: nextCount })
        }
        await patchProfile(supabaseUrl, sbHeaders, userId, patch)
      }
    } catch (e) {
      // 결과 반영 실패는 해당 건만 집계하고 배치는 계속
      console.error('[renew] 프로필 업데이트 예외 — userId:', userId, '/', e.message)
      result.details.push({ userId, error: 'profile_update_failed' })
    }
  }

  console.log('[renew] 완료 —', JSON.stringify({
    succeeded: result.succeeded, failed: result.failed,
    skipped: result.skipped, downgraded: result.downgraded,
  }))

  res.writeHead(200, JSON_HEADERS)
  res.end(JSON.stringify(result))
}

async function patchProfile(supabaseUrl, sbHeaders, userId, patch) {
  const r = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
    { method: 'PATCH', headers: sbHeaders, body: JSON.stringify(patch) }
  )
  if (!r.ok) {
    const t = await r.text()
    throw new Error(`Supabase PATCH ${r.status}: ${t}`)
  }
}
