"""거래 입력 검증(2026-11-11): 유한하지 않은 수량·단가는 원장에 들어가기 전에 막는다.
float("nan")·float("inf")는 예외 없이 변환되고 `<= 0` 비교도 통과해, 그대로 두면 잔고·스냅샷이 NaN으로 번진다."""
import unittest

from portfolio_core.transactions import require_positive_float


class RequirePositiveFloatTests(unittest.TestCase):
    def test_accepts_positive_numbers_and_numeric_text(self):
        self.assertEqual(require_positive_float("1.5", "수량"), 1.5)
        self.assertEqual(require_positive_float(3, "단가"), 3.0)

    def test_rejects_non_finite_values(self):
        for value in ("nan", "NaN", "inf", "Infinity", "1e999", float("nan"), float("inf")):
            with self.assertRaisesRegex(ValueError, "수량은 숫자여야 합니다"):
                require_positive_float(value, "수량")

    def test_rejects_zero_negative_and_non_numbers(self):
        for value in (0, -1, "-inf"):
            with self.assertRaises(ValueError):
                require_positive_float(value, "수량")
        for value in (None, "", "abc", [1]):
            with self.assertRaisesRegex(ValueError, "단가은 숫자여야 합니다"):
                require_positive_float(value, "단가")


if __name__ == "__main__":
    unittest.main()
