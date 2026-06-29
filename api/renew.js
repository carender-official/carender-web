// 정기결제 자동갱신 스케줄러 (Vercel Cron → 매일 1회)
// 청구 대상: subscription_status IN ('active','past_due') AND next_billing_date <= now()
// canceled / expired 는 어떤 경우에도 청구 대상에서 제외된다.

const JSON_HEADERS = { 'Content-Type': 'application/json' }

const { addMonthsClamped, seoulYmd } = require('./_lib/billing-date')
// 플랜 가격/키는 billing.js 와 공용 — 중복정의 금지.
// (월 구독만 가격이 정의됨. 'year' 는 가격 미정 → 아래 청구 루프에서 스킵.)
const { PLAN_PRICING, resolvePlanKey } = require('./_lib/plan-pricing')

const MAX_RETRY = 3   // billing_retry_count 가 이 값을 "초과"하면 다운그레이드

// 같은 날 cron 이 중복 실행돼도 동일 merchant_uid 로 PortOne 가 이중 결제를 막도록
// merchant_uid 는 KST 날짜(YYYYMMDD)로 결정적 생성(seoulYmd, _lib 공용). 익일 재시도는 새 uid.

// reset_date 컬럼용: KST 오늘 날짜를 'YYYY-MM-DD'(대시 포함)로 반환.
// (사용량 리더가 reset_date.slice(0,7)='YYYY-MM' 로 월 비교하므로 대시 포함 형식이어야 한다.)
function seoulDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}

// 기존 next_billing_date 를 앵커로 다음 주기 계산 (now() 기준 아님 → 무료 구간 누적 방지)
function extendFromAnchor(anchorIso, interval) {
  const months = interval === 'year' ? 12 : 1
  return addMonthsClamped(new Date(anchorIso), months).toISOString()
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

  // ── 1.5 상태 강등 (결제와 무관 — PortOne 토큰 불필요, UPDATE 전용) ──────
  // 기존 결제 대상 쿼리/again/결제 루프와 완전히 분리된 선행 처리.
  // 절대시각(UTC ISO)으로 비교하며, 아래 결제 로직의 nowIso 와는 별도 변수를 쓴다.
  const degradeNowIso = new Date().toISOString()
  let trialExpiredCount = 0
  let cancelExpiredCount = 0

  // 블록 1 — 체험 만료 서버 강등: is_trial=true AND trial_end_date < now
  // 단, 빌링키(customer_uid)가 있는 체험 유저는 강등 대상에서 제외한다.
  // (체험 중 결제로 next_billing_date=trial_end_date 가 예약돼 있으므로, 만료 시점에
  //  아래 청구 루프가 잡아서 첫 청구를 일으킨다. free 로 내리면 안 된다.)
  // 쿼리에서 customer_uid=is.null 로 1차 제외 + 루프에서 명시적으로 한 번 더 가드.
  try {
    const q1 = `${supabaseUrl}/rest/v1/profiles`
      + `?select=id,customer_uid`
      + `&is_trial=eq.true`
      + `&trial_end_date=lt.${encodeURIComponent(degradeNowIso)}`
      + `&customer_uid=is.null`
    const r1 = await fetch(q1, { headers: sbHeaders })
    if (r1.ok) {
      const expiredTrials = await r1.json()
      for (const t of expiredTrials) {
        if (t.customer_uid) {
          // 빌링키 보유 → 강등 금지(청구 루프에 위임). 쿼리 필터의 안전장치.
          continue
        }
        try {
          await patchProfile(supabaseUrl, sbHeaders, t.id, { plan: 'free', is_trial: false })
          trialExpiredCount++
        } catch (e) {
          console.error('[renew] 체험 만료 강등 실패 — userId:', t.id, '/', e.message)
        }
      }
    } else {
      console.error('[renew] 체험 만료 대상 조회 실패 — status:', r1.status)
    }
  } catch (e) {
    console.error('[renew] 체험 만료 블록 예외:', e.message)
  }

  // 블록 2 — 해지 후 만료 강등: subscription_status='canceled' AND next_billing_date < now
  // reset_date 는 가입일 기준이므로 전환일로 박지 않는다 → 직후 1.6 reset_expired_usage 가 가입일 기준으로 처리.
  try {
    const q2 = `${supabaseUrl}/rest/v1/profiles`
      + `?select=id`
      + `&subscription_status=eq.canceled`
      + `&next_billing_date=lt.${encodeURIComponent(degradeNowIso)}`
    const r2 = await fetch(q2, { headers: sbHeaders })
    if (r2.ok) {
      const expiredCancels = await r2.json()
      for (const c of expiredCancels) {
        try {
          await patchProfile(supabaseUrl, sbHeaders, c.id, {
            plan:                'free',
            subscription_status: 'expired',
          })
          cancelExpiredCount++
        } catch (e) {
          console.error('[renew] 해지 만료 강등 실패 — userId:', c.id, '/', e.message)
        }
      }
    } else {
      console.error('[renew] 해지 만료 대상 조회 실패 — status:', r2.status)
    }
  } catch (e) {
    console.error('[renew] 해지 만료 블록 예외:', e.message)
  }

  console.log('[renew] 상태 강등 —', JSON.stringify({ trial_expired: trialExpiredCount, cancel_expired: cancelExpiredCount }))

  // ── 1.6 만료된 무료 유저 사용량 자동 리셋 (RPC, 결제 무관) ──────────────
  // 강등 블록 직후 실행 → 같은 실행에서 free 로 막 전환된 유저도 리셋 대상에 포함.
  // reset_expired_usage() 는 인자 없는 Supabase 함수(리셋된 행 수 integer 반환).
  let usageResetCount = 0
  try {
    const rpcRes = await fetch(`${supabaseUrl}/rest/v1/rpc/reset_expired_usage`, {
      method: 'POST',
      headers: sbHeaders,
      body: '{}',
    })
    if (rpcRes.ok) {
      const rpcBody = await rpcRes.json()
      usageResetCount = typeof rpcBody === 'number' ? rpcBody : (Number(rpcBody) || 0)
    } else {
      console.error('[renew] 사용량 리셋 RPC 실패 — status:', rpcRes.status, '/', await rpcRes.text())
    }
  } catch (e) {
    console.error('[renew] 사용량 리셋 RPC 예외:', e.message)
  }

  console.log('[renew] 사용량 자동 리셋 —', JSON.stringify({ usage_reset: usageResetCount }))

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
      + `?select=id,customer_uid,pending_plan,plan,subscription_status,next_billing_date,billing_retry_count`
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
    trial_expired: trialExpiredCount,
    cancel_expired: cancelExpiredCount,
    usage_reset: usageResetCount,
    details: [],
  }

  // ── 4. 대상별 재청구 (순차 처리) ──────────────────────────────
  for (const row of targets) {
    const userId = row.id
    const customerUid = row.customer_uid
    const interval = row.billing_interval || 'month'   // 컬럼 없으면 월 구독으로 간주
    // 예약 다운그레이드 우선: pending_plan 이 있으면 그 plan 으로 금액·plan 결정(이번 청구부터 적용).
    // pending_plan 이 없거나 미식별이면 기존 plan 으로 청구.
    const planKey = resolvePlanKey(row.pending_plan) || resolvePlanKey(row.plan)

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
    let lastImpUid = null   // payData 는 try 블록 const 스코프 → patch 에서 못 봄. imp_uid 만 외부 변수로 끌어올림.
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
      lastImpUid = (payData && payData.response && payData.response.imp_uid) || null
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
        // + 새 결제 사이클 시작이므로 사용량 카운터 0 리필 + reset_date 를 오늘(KST)로 갱신
        const patch = {
          subscription_status: 'active',
          plan:                planKey,                                  // premium → pro 수렴 / 예약 다운 적용분
          is_trial:            false,                                   // 청구 성공 = 체험 종료 = 유료 전환 확정(체험 첫 청구만 true→false, 비체험은 false→false 무해)
          pending_plan:        null,                                    // 예약 소진(없었으면 그대로 null)
          next_billing_date:   extendFromAnchor(row.next_billing_date, interval),
          last_payment_at:     nowIso,
          billing_retry_count: 0,
          monthly_shared_events:    0,                                   // 덮어쓰기(누적 아님)
          monthly_upload_mb:        0,                                   // 덮어쓰기(누적 아님)
          shared_events_reset_date: seoulDate(new Date()),              // KST 'YYYY-MM-DD'
          upload_reset_date:        seoulDate(new Date()),              // KST 'YYYY-MM-DD'
          service_used_at:          null,                              // 매 갱신마다 미사용 리셋(갱신 결제도 7일 환불 적용)
          last_imp_uid:             lastImpUid,
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
