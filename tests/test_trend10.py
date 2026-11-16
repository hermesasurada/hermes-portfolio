"""10년 추세(trend10_*, 2026-11-16): 5년 추세와 같은 산식, 창은 최근 10년(날짜 기준), 10년 미만 이력은 빈 칸."""
import math
from datetime import date, timedelta

from portfolio_core.technical_stats import trend_performance, trend_performance_10y


def business_days(start: date, end: date) -> list[str]:
    out, d = [], start
    while d <= end:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


end = date(2026, 11, 13)
dates = business_days(date(2015, 11, 13), end)   # 11년
n = len(dates)

# 1) 꾸준한 직선 성장(연 약 10%): 10년 강도가 크다.
steady = [math.exp(0.10 / 252 * i * (252 / 261)) for i in range(n)]
t = trend_performance_10y(steady, dates)
assert set(t) == {"trend10_return", "trend10_r2", "trend10_deviation", "trend10_strength"}
assert 9 < t["trend10_return"] < 11, t
assert t["trend10_deviation"] < 0.5 and t["trend10_r2"] > 0.99, t

# 2) 6년 횡보 뒤 최근 5년 급등(CAH 모양): 5년 강도는 높고 10년 강도는 낮다.
split = next(i for i, d in enumerate(dates) if d >= (end.replace(year=end.year - 5)).isoformat())
surge = [1.0 + 0.03 * math.sin(i / 40) if i < split else math.exp(0.35 / 252 * (i - split) * (252 / 261)) * (1 + 0.05 * math.sin(i / 30)) for i in range(n)]
five = trend_performance(surge)
ten = trend_performance_10y(surge, dates)
assert five["trend_strength"] > 3 * ten["trend10_strength"], (five, ten)
assert ten["trend10_deviation"] > five["trend_deviation"], (five, ten)

# 3) 10년이 안 되는 이력은 계산하지 않는다(짧은 이력을 환산해 채우지 않음).
recent = [d for d in dates if d >= "2018-01-01"]
assert trend_performance_10y(steady[-len(recent):], recent) == {
    "trend10_return": None, "trend10_r2": None, "trend10_deviation": None, "trend10_strength": None}
# 경계에서 한 달 이내 늦게 시작한 이력(수집 시작일·연휴)은 10년치로 본다.
late = [d for d in dates if d >= "2016-12-01"]
assert trend_performance_10y(steady[-len(late):], late)["trend10_return"] is not None
# 창은 날짜로 자른다 — 11년 이력을 줘도 10년만 쓴다(첫 해를 망가뜨려도 값이 같다).
broken = [0.2 if d < "2016-11-01" else v for d, v in zip(dates, steady)]
assert trend_performance_10y(broken, dates) == t
# 길이가 다르면 빈 칸
assert trend_performance_10y(steady, dates[:-1])["trend10_return"] is None
print("trend10 checks passed")
