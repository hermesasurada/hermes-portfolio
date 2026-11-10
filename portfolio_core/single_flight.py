"""같은 키의 백그라운드 작업을 한 번에 하나만 돌린다(stale-while-revalidate용).

웹 요청 경로에서 외부 시세를 동기로 기다리면 캐시가 만료될 때마다 응답이 ~1초 늦었다.
캐시가 조금 묵었으면 그 값을 바로 돌려주고, 갱신은 여기로 넘겨 뒤에서 한 번만 돌린다.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Callable, Hashable, Iterable


class SingleFlight:
    def __init__(self, name: str) -> None:
        self.name = name
        self._lock = threading.Lock()
        self._busy: dict[Hashable, threading.Event] = {}  # 키 → 그 키를 맡은 실행이 끝나면 켜지는 신호
        self.last_thread: threading.Thread | None = None  # 테스트가 끝나기를 기다릴 때 쓴다

    def in_flight(self, key: Hashable) -> bool:
        with self._lock:
            return key in self._busy

    def run(self, keys: Iterable[Hashable], work: Callable[[list], object]) -> list:
        """이미 돌고 있는 키는 빼고 나머지로 work(keys)를 백그라운드에서 한 번 실행한다.
        실제로 넘긴 키 목록을 돌려준다(없으면 빈 목록 — 아무것도 시작하지 않았다)."""
        with self._lock:
            todo = [key for key in dict.fromkeys(keys) if key not in self._busy]
            done = threading.Event()
            self._busy.update({key: done for key in todo})
        if not todo:
            return []

        def worker() -> None:
            try:
                work(todo)
            except Exception as exc:  # noqa: BLE001 — 백그라운드 실패는 다음 요청이 다시 시도한다
                logging.warning("[%s] background refresh failed for %d keys: %s", self.name, len(todo), exc)
            finally:
                with self._lock:
                    for key in todo:
                        if self._busy.get(key) is done:
                            del self._busy[key]
                done.set()

        thread = threading.Thread(target=worker, name=f"{self.name}-refresh", daemon=True)
        self.last_thread = thread
        thread.start()
        return todo

    def run_and_wait(self, keys: Iterable[Hashable], work: Callable[[list], object], timeout: float) -> bool:
        """run()과 같되, 넘긴 키(이미 돌고 있던 키 포함)가 끝나기를 최대 timeout초 기다린다.
        웹 요청은 외부 시세가 빨리 오면 그 값을 쓰고, 늦으면(DNS 장애 등) 기다리지 않고 캐시로 답한다.
        모두 끝났으면 True."""
        keys = list(dict.fromkeys(keys))
        self.run(keys, work)
        with self._lock:
            events = {id(event): event for key in keys if (event := self._busy.get(key)) is not None}
        deadline = time.monotonic() + max(0.0, timeout)
        for event in events.values():
            if not event.wait(max(0.0, deadline - time.monotonic())):
                return False
        return True
