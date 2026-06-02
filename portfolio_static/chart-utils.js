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
