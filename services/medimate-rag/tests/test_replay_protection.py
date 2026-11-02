"""
MediMate AI — Distributed Replay Protection Tests
Tests MemoryReplayRegistry and RedisReplayRegistry across instances, expirations,
and outage fail-closed policies.
"""

import time
import pytest
from app.core.config import Settings
from app.core.errors import AuthenticationError
from app.security.replay import (
    MemoryReplayRegistry,
    RedisReplayRegistry,
    set_replay_registry,
    get_replay_registry,
)


class FakeRedisClient:
    """Mock Redis client simulating atomic SET NX EX behavior and outages."""

    def __init__(self):
        self._store = {}
        self.is_offline = False

    def set(self, key: str, value: str, nx: bool = False, ex: int = 60):
        if self.is_offline:
            raise ConnectionError("Simulated Redis network partition / outage")

        now = time.time()
        # Clean expired
        self._store = {k: (v, exp) for k, (v, exp) in self._store.items() if exp > now}

        if nx and key in self._store:
            return None  # Key already exists -> NX fails

        self._store[key] = (value, now + ex)
        return True


def test_memory_replay_registry():
    registry = MemoryReplayRegistry(max_entries=100)
    exp = time.time() + 60

    assert registry.register_nonce("nonce_1", exp) is True
    # Replay of same nonce must be rejected
    assert registry.register_nonce("nonce_1", exp) is False
    # Distinct nonce must succeed
    assert registry.register_nonce("nonce_2", exp) is True


def test_redis_replay_registry_multi_instance_coordination():
    fake_redis = FakeRedisClient()

    # Instance A and Instance B share the same Redis backplane
    instance_a = RedisReplayRegistry("redis://localhost:6379/0")
    instance_a._client = fake_redis

    instance_b = RedisReplayRegistry("redis://localhost:6379/0")
    instance_b._client = fake_redis

    exp = time.time() + 60
    nonce = "cross_replica_nonce_99"

    # Instance A receives request first
    assert instance_a.register_nonce(nonce, exp) is True

    # Replayed assertion sent to Instance B must be REJECTED
    assert instance_b.register_nonce(nonce, exp) is False


def test_redis_replay_registry_expiration():
    fake_redis = FakeRedisClient()
    registry = RedisReplayRegistry("redis://localhost:6379/0")
    registry._client = fake_redis

    # Expired nonce (TTL = 1s)
    exp = time.time() + 1.0
    nonce = "short_lived_nonce"

    assert registry.register_nonce(nonce, exp) is True
    # Wait for expiry in fake redis
    time.sleep(1.1)
    # After expiry, the nonce key is purged and register can succeed again
    assert registry.register_nonce(nonce, time.time() + 60) is True


def test_redis_replay_registry_fail_closed_on_outage(monkeypatch):
    fake_redis = FakeRedisClient()
    fake_redis.is_offline = True

    registry = RedisReplayRegistry("redis://localhost:6379/0")
    registry._client = fake_redis

    # Under production, Redis outage MUST fail closed
    from app.core import config
    monkeypatch.setattr(config.settings, "environment", "production")

    with pytest.raises(AuthenticationError, match="Distributed assertion replay protection is currently unavailable"):
        registry.register_nonce("nonce_during_outage", time.time() + 60)
