function pctChartLabel(value) {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${pctFmt.format(Math.abs(value))}%`;
}

// 차트 안에 붙는 % — 선 옆 끝라벨·호버 툴팁처럼 자리가 좁은 곳은 소수 첫째 자리까지.
function pctChartLabel1(value) {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${fmt1.format(Math.abs(value))}%`;
}

function chartGridUnit(rangeKey) {
  if (rangeKey === "1w") return "day";
  if (rangeKey === "1m") return "week";
  if (rangeKey === "3y" || rangeKey === "5y") return "quarter";
  return "month";
}

function verticalDateGrid(minTime, maxTime, rangeKey) {
  const unit = chartGridUnit(rangeKey);
  const start = new Date(minTime);
  let cursor;
  if (unit === "day") {
    cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    if (cursor.getTime() < minTime) cursor.setDate(cursor.getDate() + 1);
  } else if (unit === "week") {
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
    if (unit === "day") cursor.setDate(cursor.getDate() + 1);
    else if (unit === "week") cursor.setDate(cursor.getDate() + 7);
    else if (unit === "quarter") cursor.setMonth(cursor.getMonth() + 3);
    else cursor.setMonth(cursor.getMonth() + 1);
  }
  return { unit, lines };
}

function chartGridLabel(time, unit) {
  const d = new Date(time);
  if (unit === "day" || unit === "week") return `${d.getMonth() + 1}/${d.getDate()}`;
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

function declutterChartLabels(labels, minGap) {
  const sorted = [...labels].sort((left, right) => left.y - right.y);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].y - sorted[index - 1].y < minGap) {
      sorted[index].y = sorted[index - 1].y + minGap;
    }
  }
  return sorted;
}

// 호버 레이어 포인터 와이어링: 이동/진입 시 표시, 터치는 핀 고정, 이탈 시 숨김
// 성과·비교 차트의 호버. 마우스는 따라다니고, 터치는 누른 자리에 고정한다.
// 고정된 툴팁은 다음 터치에 닫힌다(2026-11-21 사용자 지시 — 예전엔 닫을 방법이 없었다): 차트 밖이든 안이든
// 한 번 더 누르면 닫히고, 그 터치는 새 툴팁을 띄우지 않는다. 종목 차트의 길게 누르기(bindChartLongPress)와 같은 규칙.
function bindHoverPointerEvents(hoverLayer, showPoint, hide) {
  let touchPinned = false;
  let skipNextTouch = false;
  const dismiss = event => {
    if (event.pointerType !== "touch" || !touchPinned) return;
    touchPinned = false;
    document.removeEventListener("pointerdown", dismiss, true);
    hide();
    if (event.target === hoverLayer || hoverLayer.contains?.(event.target)) skipNextTouch = true;
  };
  hoverLayer.addEventListener("pointermove", event => {
    if (event.pointerType === "touch" && !touchPinned) return;
    showPoint(event.clientX);
  });
  hoverLayer.addEventListener("pointerenter", event => {
    if (event.pointerType !== "touch") showPoint(event.clientX);
  });
  hoverLayer.addEventListener("pointerdown", event => {
    if (event.pointerType !== "touch") return;
    if (skipNextTouch) {   // 닫으려고 누른 터치
      skipNextTouch = false;
      return;
    }
    touchPinned = true;
    showPoint(event.clientX);
    // 지금 이벤트의 캡처 단계는 이미 지났으므로 이 터치로는 닫히지 않는다.
    document.addEventListener("pointerdown", dismiss, true);
  });
  hoverLayer.addEventListener("pointerleave", () => {
    if (!touchPinned) hide();
  });
}

// 파일 끝 로드 마커 — 파스 에러·태그 미닫힘 시 이 줄이 실행되지 않아 부트 검사에 걸린다
(window.__loaded = window.__loaded || new Set()).add("chart-utils");
