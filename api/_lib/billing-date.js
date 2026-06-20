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
module.exports = { addMonthsClamped }
