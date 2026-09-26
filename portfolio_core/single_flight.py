"""같은 키의 백그라운드 작업을 한 번에 하나만 돌린다(stale-while-revalidate용).

웹 요청 경로에서 외부 시세를 동기로 기다리면 캐시가 만료될 때마다 응답이 ~1초 늦었다.
캐시가 조금 묵었으면 그 값을 바로 돌려주고, 갱신은 여기로 넘겨 뒤에서 한 번만 돌린다.
"""
from __future__ import annotations

import logging
import threading
from typing import Callable, Hashable, Iterable


class SingleFlight:
    def __init__(self, name: str) -> None:
        self.name = name
        self._lock = threading.Lock()
        self._busy: set[Hashable] = set()
        self.last_thread: threading.Thread | None = None  # 테스트가 끝나기를 기다릴 때 쓴다

    def in_flight(self, key: Hashable) -> bool:
        with self._lock:
            return key in self._busy

    def run(self, keys: Iterable[Hashable], work: Callable[[list], object]) -> list:
        """이미 돌고 있는 키는 빼고 나머지로 work(keys)를 백그라운드에서 한 번 실행한다.
        실제로 넘긴 키 목록을 돌려준다(없으면 빈 목록 — 아무것도 시작하지 않았다)."""
        with self._lock:
            todo = [key for key in dict.fromkeys(keys) if key not in self._busy]
            self._busy.update(todo)
        if not todo:
            return []

        def worker() -> None:
            try:
                work(todo)
            except Exception as exc:  # noqa: BLE001 — 백그라운드 실패는 다음 요청이 다시 시도한다
                logging.warning("[%s] background refresh failed for %d keys: %s", self.name, len(todo), exc)
            finally:
                with self._lock:
                    self._busy.difference_update(todo)

        thread = threading.Thread(target=worker, name=f"{self.name}-refresh", daemon=True)
        self.last_thread = thread
        thread.start()
        return todo
