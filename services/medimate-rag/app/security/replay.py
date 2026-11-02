"""
MediMate AI — Distributed Assertion Replay Protection
Provides atomic, Redis-backed nonce registration across multiple microservice replicas.
Fails closed when distributed protection is required but unavailable.
"""

from abc import ABC, abstractmethod
import time
import threading
from typing import Dict, Optional
from app.core.config import settings
from app.core.errors import AuthenticationError
from app.core.logging import logger


class BaseReplayRegistry(ABC):
    @abstractmethod
    def register_nonce(self, nonce: str, exp_epoch: float) -> bool:
        """
        Atomically registers a nonce until its expiration timestamp.
        Returns True if the nonce was novel (registered successfully).
        Returns False if the nonce was already registered (replay detected).
        """
        pass


class MemoryReplayRegistry(BaseReplayRegistry):
    """In-memory nonce registry for unit tests and local isolated development."""

    def __init__(self, max_entries: int = 20000):
        self._cache: Dict[str, float] = {}
        self._lock = threading.Lock()
        self._max_entries = max_entries

    def register_nonce(self, nonce: str, exp_epoch: float) -> bool:
        now = time.time()
        with self._lock:
            # Purge expired nonces if cache size exceeds limit
            if len(self._cache) > self._max_entries:
                self._cache = {n: exp for n, exp in self._cache.items() if exp > now}

            if nonce in self._cache:
                return False  # Replay detected

            self._cache[nonce] = exp_epoch
            return True


class RedisReplayRegistry(BaseReplayRegistry):
    """
    Distributed Redis-backed nonce registry.
    Ensures multi-replica protection and survives service restarts.
    """

    def __init__(self, redis_url: str):
        self.redis_url = redis_url
        self._client = None
        self._lock = threading.Lock()

    def _get_client(self):
        if self._client is None:
            with self._lock:
                if self._client is None:
                    import redis
                    self._client = redis.Redis.from_url(
                        self.redis_url,
                        decode_responses=True,
                        socket_timeout=2.0,
                        socket_connect_timeout=2.0,
                    )
        return self._client

    def register_nonce(self, nonce: str, exp_epoch: float) -> bool:
        ttl = max(1, int(exp_epoch - time.time()))
        key = f"rag:replay:nonce:{nonce}"

        try:
            client = self._get_client()
            # SET key value NX EX ttl: returns True if key was set, None if key already existed
            res = client.set(key, "1", nx=True, ex=ttl)
            if res is True or res == 1:
                return True
            return False  # Key already existed -> replay detected!
        except Exception as e:
            logger.error("Redis replay protection registry outage", {"error": str(e)})
            if settings.environment in ("staging", "production"):
                # Strict fail-closed policy: reject requests when shared replay protection is unavailable
                raise AuthenticationError(
                    "Distributed assertion replay protection is currently unavailable. Request rejected fail-closed."
                )
            # In local dev only, fail closed if redis was explicitly configured
            raise AuthenticationError(f"Redis replay registry communication failure: {str(e)}")


_global_replay_registry: Optional[BaseReplayRegistry] = None


def get_replay_registry() -> BaseReplayRegistry:
    global _global_replay_registry
    if _global_replay_registry is None:
        if settings.redis_url:
            _global_replay_registry = RedisReplayRegistry(settings.redis_url)
            logger.info("Initialized RedisReplayRegistry for distributed assertion protection")
        else:
            if settings.environment in ("staging", "production"):
                raise AuthenticationError("REDIS_URL must be configured for replay protection in production")
            _global_replay_registry = MemoryReplayRegistry()
            logger.info("Initialized MemoryReplayRegistry for local development")
    return _global_replay_registry


def set_replay_registry(registry: Optional[BaseReplayRegistry]) -> None:
    """Allows testing harnesses to inject mock or alternate replay registries."""
    global _global_replay_registry
    _global_replay_registry = registry
