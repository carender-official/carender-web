// 앵커 날짜에서 N개월 뒤, 말일 클램프 적용
// 예: 1/31 +1개월 → 2/28(또는 2/29), 3/31 +1개월 → 4/30
function addMonthsClamped(date, months) {
  const d = new Date(date)
  const targetDay = d.getDate()
  d.setDate(1)                          // 먼저 1일로 (오버플로우 방지)
  d.setMonth(d.getMonth() + months)
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(targetDay, lastDay))
  return d
}

// merchant_uid 등에 쓰는 결정적 날짜키: Asia/Seoul 기준 'YYYYMMDD'.
// (서버 타임존과 무관하게 항상 KST 날짜를 쓴다.)
function seoulYmd(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date).replace(/-/g, '')
}

module.exports = { addMonthsClamped, seoulYmd }
