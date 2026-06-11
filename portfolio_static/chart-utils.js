function pctChartLabel(value) {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${fmt2.format(Math.abs(value))}%`;
}

function chartGridUnit(rangeKey) {
  if (rangeKey === "1m") return "week";
  if (rangeKey === "3y" || rangeKey === "5y") return "quarter";
  return "month";
}

function verticalDateGrid(minTime, maxTime, rangeKey) {
  const unit = chartGridUnit(rangeKey);
  const start = new Date(minTime);
  let cursor;
  if (unit === "week") {
    cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7));
    if (cursor.getTime() < minTime) cursor.setDate(cursor.getDate() + 7);
  } else if (unit === "quarter") {
    cursor = new Date(start.getFullYear(), Math.floor(start.getMonth() / 3) * 3, 1);
    if (cursor.getTime() < minTime) cursor.setMonth(cursor.getMonth() + 3);
  } else {
    cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    if (cursor.getTime() < minTime) cursor.setMonth(cursor.getMonth() + 1);
  }
  const lines = [];
  let guard = 0;
  while (cursor.getTime() <= maxTime && guard++ < 240) {
    lines.push(cursor.getTime());
    if (unit === "week") cursor.setDate(cursor.getDate() + 7);
    else if (unit === "quarter") cursor.setMonth(cursor.getMonth() + 3);
    else cursor.setMonth(cursor.getMonth() + 1);
  }
  return { unit, lines };
}

function chartGridLabel(time, unit) {
  const d = new Date(time);
  if (unit === "week") return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${String(d.getFullYear()).slice(2)}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const perfVerticalGrid = verticalDateGrid;
const perfGridLabel = chartGridLabel;

// ── 호버 공통 헬퍼 (성과/비교 차트가 동일 로직을 복제하던 것을 모음) ──

// 시계열에서 목표 시각과 가장 가까운 점
function nearestChartPoint(points, targetTime) {
  return points.reduce((best, point) => {
    const distance = Math.abs(point.time - targetTime);
    return !best || distance < best.distance ? { point, distance } : best;
  }, null)?.point;
}

// HTML 오버레이 툴팁을 호버선 옆에 배치 (우측 가장자리에선 좌측으로 플립)
function placeChartHoverTooltip(tooltip, canvas, svgRect, geometry, x) {
  const canvasRect = canvas.getBoundingClientRect();
  const lineClientX = svgRect.left + (x / geometry.width) * svgRect.width;
  const tipW = tooltip.offsetWidth;
  let leftPx = (lineClientX - canvasRect.left) + 14;
  if (leftPx + tipW > canvasRect.width - 6) leftPx = (lineClientX - canvasRect.left) - tipW - 14;
  if (leftPx < 6) leftPx = 6;
  const topPx = (svgRect.top - canvasRect.top) + (geometry.pad.top / geometry.height) * svgRect.height + 4;
  tooltip.style.left = `${leftPx.toFixed(0)}px`;
  tooltip.style.top = `${Math.max(4, topPx).toFixed(0)}px`;
}

// 호버 레이어 포인터 와이어링: 이동/진입 시 표시, 터치는 핀 고정, 이탈 시 숨김
function bindHoverPointerEvents(hoverLayer, showPoint, hide) {
  let touchPinned = false;
  hoverLayer.addEventListener("pointermove", event => showPoint(event.clientX));
  hoverLayer.addEventListener("pointerenter", event => showPoint(event.clientX));
  hoverLayer.addEventListener("pointerdown", event => {
    if (event.pointerType !== "touch") return;
    touchPinned = true;
    showPoint(event.clientX);
  });
  hoverLayer.addEventListener("pointerleave", () => {
    if (!touchPinned) hide();
  });
}
