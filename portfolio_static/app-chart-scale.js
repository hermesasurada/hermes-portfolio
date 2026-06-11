// 차트 공용 헬퍼: 포맷·기간·스케일(nice/log/비교로그)·스무딩·그리드. app-line-chart.js에서 분리.
function chartMoney(value, currency, ticker = "") {
  if (!Number.isFinite(value)) return "-";
  return unitMoney(value, currency, ticker).replace(/<[^>]+>/g, "");
}

function signedChartMoney(value, currency, ticker = "") {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${chartMoney(Math.abs(value), currency, ticker)}`;
}

function chartFullDateLabel(dateText) {
  if (!dateText) return "-";
  const text = String(dateText);
  return text.length >= 10 ? text.slice(0, 10).replaceAll("-", ".") : text;
}

function chartDateObject(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ""))) return null;
  const date = new Date(`${dateText}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function chartRangeStartDate(points, rangeKey) {
  const lastDateText = points[points.length - 1]?.date;
  if (!lastDateText) return null;
  const lastDate = new Date(`${lastDateText}T00:00:00`);
  if (Number.isNaN(lastDate.getTime())) return null;
  if (rangeKey === "all" || rangeKey === "cmax") return null;   // 전체/최대: 시작 제한 없음
  if (rangeKey === "ytd") {
    return new Date(lastDate.getFullYear(), 0, 1);
  }
  const range = chartRanges.find(item => item.key === rangeKey) || chartRanges.find(item => item.key === "1y");
  const start = new Date(lastDate);
  start.setMonth(start.getMonth() - (range.months || 12));
  return start;
}

function chartRangeBounds(points, rangeKey) {
  if (rangeKey === "custom") {
    return {
      startDate: chartDateObject(chartCustomRange.start),
      endDate: chartDateObject(chartCustomRange.end),
    };
  }
  return {
    startDate: chartRangeStartDate(points, rangeKey),
    endDate: null,
  };
}

function filterChartPoints(points, rangeKey) {
  if (!points.length) return points;
  const { startDate, endDate } = chartRangeBounds(points, rangeKey);
  if (!startDate && !endDate) return points;
  const filtered = points.filter(point => {
    const date = new Date(`${point.date}T00:00:00`);
    return (!startDate || date >= startDate) && (!endDate || date <= endDate);
  });
  if (rangeKey === "custom") return filtered;
  return filtered.length >= 2 ? filtered : points.slice(-Math.min(points.length, 2));
}

function chartIntervalKey(dateText, interval) {
  if (interval === "month") return String(dateText || "").slice(0, 7);
  if (interval !== "week") return String(dateText || "");
  const date = new Date(`${dateText}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return String(dateText || "");
  const daysFromMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysFromMonday);
  return date.toISOString().slice(0, 10);
}

function aggregateChartPoints(points, interval = chartInterval) {
  const clean = (points || []).filter(point => point?.date);
  if (interval === "day") return clean;
  const grouped = new Map();
  clean.forEach(point => {
    const key = chartIntervalKey(point.date, interval);
    const previous = grouped.get(key);
    const rsi = point.rsi != null && Number.isFinite(Number(point.rsi))
      ? Number(point.rsi)
      : previous?.rsi;
    grouped.set(key, { ...point, ...(Number.isFinite(rsi) ? { rsi } : {}) });
  });
  return Array.from(grouped.values());
}

function niceChartStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const power = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / power;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return nice * power;
}

function niceChartScale(values, desiredTicks = 5) {
  const cleanValues = values.filter(value => Number.isFinite(value));
  if (!cleanValues.length) return { min: 0, max: 1, ticks: [0, .25, .5, .75, 1] };
  const rawMin = Math.min(...cleanValues);
  const rawMax = Math.max(...cleanValues);
  const rawRange = rawMax - rawMin || Math.max(1, Math.abs(rawMax));
  const paddedMin = rawMin - rawRange * 0.05;
  const paddedMax = rawMax + rawRange * 0.12;
  const step = niceChartStep((paddedMax - paddedMin) / Math.max(1, desiredTicks - 1));
  const min = Math.floor(paddedMin / step) * step;
  const max = Math.ceil(paddedMax / step) * step;
  const ticks = [];
  for (let value = min; value <= max + step / 2; value += step) {
    ticks.push(Math.abs(value) < step / 1_000_000 ? 0 : value);
  }
  return { min, max, ticks };
}

function logChartScale(values, desiredTicks = 5) {
  const clean = values.filter(value => Number.isFinite(value) && value > 0);
  if (clean.length < 1) return niceChartScale(values, desiredTicks);
  const rawMin = Math.min(...clean);
  const rawMax = Math.max(...clean);
  const lMin = Math.log10(rawMin);
  const lMax = Math.log10(rawMax);
  const pad = Math.max((lMax - lMin) * 0.06, 0.01);
  const min = Math.pow(10, lMin - pad);
  const max = Math.pow(10, lMax + pad);
  // 1·2·5 ×10^n 위치의 nice 로그 틱
  const ticks = [];
  for (let decade = Math.floor(Math.log10(min)); decade <= Math.ceil(Math.log10(max)); decade += 1) {
    for (const mult of [1, 2, 5]) {
      const value = mult * Math.pow(10, decade);
      if (value >= min && value <= max) ticks.push(value);
    }
  }
  if (ticks.length < 2) return { min, max, ticks: [min, Math.sqrt(min * max), max], log: true };
  return { min, max, ticks, log: true };
}

// 비교 차트 로그 스케일: %는 음수가 될 수 있어 (1+%/100) 비율을 로그축에 올린다.
const COMPARE_LOG_NICE_RATIOS = [
  0.05, 0.1, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75,
  2, 2.5, 3, 4, 5, 7.5, 10, 15, 20, 30, 50, 100, 200, 500,
];
function compareLogScale(ratios) {
  const clean = ratios.filter(value => Number.isFinite(value) && value > 0);
  if (clean.length < 1) return { min: 0.5, max: 2, ticks: [0.5, 1, 2], log: true };
  const lo = Math.min(...clean);
  const hi = Math.max(...clean);
  const pad = Math.max((Math.log10(hi) - Math.log10(lo)) * 0.06, 0.02);
  const min = Math.pow(10, Math.log10(lo) - pad);
  const max = Math.pow(10, Math.log10(hi) + pad);
  let ticks = COMPARE_LOG_NICE_RATIOS.filter(value => value >= min && value <= max);
  if (min <= 1 && max >= 1 && !ticks.includes(1)) ticks.push(1);
  ticks.sort((a, b) => a - b);
  if (ticks.length > 8) {
    const step = Math.ceil(ticks.length / 7);
    ticks = ticks.filter((_, index) => index % step === 0 || ticks[index] === 1);
  }
  if (ticks.length < 2) ticks = [min, Math.sqrt(min * max), max];
  return { min, max, ticks, log: true };
}

// 좌표 배열 → 부드러운 곡선 path (Catmull-Rom → 베지어, 약한 텐션). 점이 조밀하면
// 거의 직선, 드물면 모서리를 둥글게. 가격 차트라 과도한 오버슈트를 피해 텐션은 작게.
function smoothLinePath(pts) {
  if (!pts.length) return "";
  if (pts.length < 3) return pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  const t = 0.16;
  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) * t;
    const c1y = p1.y + (p2.y - p0.y) * t;
    const c2x = p2.x - (p3.x - p1.x) * t;
    const c2y = p2.y - (p3.y - p1.y) * t;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  return d;
}

function straightLinePath(pts) {
  return pts
    .map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
}

function chartLinePath(pts) {
  return chartSmoothLines ? smoothLinePath(pts) : straightLinePath(pts);
}

function transactionsForChart(payload, points) {
  const start = points[0]?.date;
  const end = points[points.length - 1]?.date;
  if (!start || !end) return [];
  return (payload.transactions || [])
    .filter(tx => tx.date >= start && tx.date <= end && Number.isFinite(Number(tx.price)))
    .map(tx => ({ ...tx, price: Number(tx.price), qty: Number(tx.qty || 0) }));
}

function nearestPointIndex(points, dateText) {
  let bestIndex = 0;
  let bestDistance = Infinity;
  const target = new Date(`${dateText}T00:00:00`).getTime();
  points.forEach((point, index) => {
    const distance = Math.abs(new Date(`${point.date}T00:00:00`).getTime() - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function chartLocalDateText(time) {
  const date = new Date(time);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function indexedChartVerticalGrid(points, xFor, rangeKey) {
  if (points.length < 2) return { unit: "month", ticks: [] };
  const minTime = new Date(`${points[0].date}T00:00:00`).getTime();
  const maxTime = new Date(`${points[points.length - 1].date}T00:00:00`).getTime();
  const grid = perfVerticalGrid(minTime, maxTime, rangeKey);
  const seen = new Set();
  const ticks = grid.lines
    .map(time => {
      const date = chartLocalDateText(time);
      const index = nearestPointIndex(points, date);
      if (seen.has(index)) return null;
      seen.add(index);
      return { time, index, x: xFor(index), date: points[index].date };
    })
    .filter(Boolean);
  if (ticks.length) return { unit: grid.unit, ticks };
  return {
    unit: grid.unit,
    ticks: [0, points.length - 1]
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .map(index => ({
        time: new Date(`${points[index].date}T00:00:00`).getTime(),
        index,
        x: xFor(index),
        date: points[index].date,
      })),
  };
}

function chartExtremes(values) {
  if (!values.length) return [];
  const highIndex = values.reduce((best, value, index) => value > values[best] ? index : best, 0);
  const lowIndex = values.reduce((best, value, index) => value < values[best] ? index : best, 0);
  return [
    { kind: "high", label: "고점", index: highIndex, value: values[highIndex] },
    { kind: "low", label: "저점", index: lowIndex, value: values[lowIndex] },
  ].filter((item, index, items) => index === 0 || item.index !== items[0].index);
}
