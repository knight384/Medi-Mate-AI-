# MediMate AI

<div align="center">

**Privacy-Preserving, Evidence-Grounded AI Health Companion & Clinical Intelligence Platform**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js 14](https://img.shields.io/badge/Next.js-14_App_Router-black)](https://nextjs.org/)
[![Python 3.12](https://img.shields.io/badge/Python-3.12_FastAPI-009688)](https://fastapi.tiangolo.com/)
[![PostgreSQL 16](https://img.shields.io/badge/PostgreSQL-16_+_pgvector-336791)](https://github.com/pgvector/pgvector)
[![Redis 7](https://img.shields.io/badge/Redis-7_Alpine-DC382D)](https://redis.io/)
[![Encryption](https://img.shields.io/badge/Security-AES--256--GCM_+_AAD-green)](https://csrc.nist.gov/publications/detail/sp/800-38d/final)

</div>

---

## 📖 Overview

**MediMate AI** is an enterprise-grade personal health intelligence platform and clinical companion designed from the ground up for strict privacy, multi-tenant isolation, and verifiable medical evidence grounding. 

MediMate AI connects authorized medical lab reports, continuous wearable telemetry, longitudinal vital trends, and user-confirmed health goals into a unified, conversational health assistant.

### 🌟 Key Capabilities

- 🩺 **Evidence-Grounded RAG Retrieval:** Ingests clinical lab reports (PDF/images), segments data with Docling semantic parsing, indexes via local FastEmbed ONNX embeddings, and stores them in tenant-isolated PostgreSQL `pgvector` tables.
- 🔒 **Defense-in-Depth Cryptography:** Every medical document is encrypted using **AES-256-GCM** (`MM_ENC03` / `MM_ENC04`) with Additional Authenticated Data (AAD) bound to the owner's identity, preventing ciphertext tampering or cross-user relocation attacks.
- 🛡️ **PostgreSQL Row-Level Security:** Enforces `FORCE ROW LEVEL SECURITY` across all clinical, chat, memory, and consent tables using least-privilege runtime roles (`medimate_app` with `NOBYPASSRLS`).
- ⌚ **Wearable Telemetry Normalization:** Granular category-based consent (`HEART`, `SLEEP`, `ACTIVITY`, `VITALS`) and normalization for cloud REST connectors (Fitbit, Oura) with fail-closed stubs for mobile-bound platforms (Apple HealthKit, Google Health Connect).
- 📈 **Longitudinal Health Intelligence:** Analyzes baseline vs. follow-up telemetry intervals (e.g. resting heart rate, sleep duration) to detect meaningful statistical shifts with non-diagnostic observational notices.
- 🧠 **User-Controlled Conversational Memory:** GDPR-compliant health memory engine allowing users to inspect, pause, resume, or permanently delete recorded health topics, preferences, and goals.
- 🚨 **Clinical Safety & Emergency Triage:** Deterministic red-flag keyword short-circuiting directs acute cardiac, stroke, and respiratory symptoms directly to regional emergency services (911 / 112 / 999). Refuses autonomous diagnosis or prescription modifications.
- 🔄 **Enterprise Disaster Recovery (`MM_BAK01`):** Authenticated two-layer backup format preserving native GCM ciphertexts in cold storage without exposing unauthenticated plaintext.

---

## 🏛️ System Architecture

```mermaid
graph TD
    User([Browser Client]) -->|HTTPS :443| LB[Reverse Proxy / TLS Termination]
    LB -->|HTTP 127.0.0.1:3008| Web[Next.js 14 Web Gateway\nUID 10001 : nextjs\nRAM Scratch /tmp/scratch]
    
    subgraph medimate-prod-internal [Isolated Bridge Network (internal: true)]
        Web -->|Port 5432 medimate_app| DB[(PostgreSQL 16\npgvector 0.8.7\nFORCE ROW LEVEL SECURITY)]
        Web -->|Port 6379 requirepass| Redis[(Redis 7 AOF\nAnti-Replay Nonces)]
        Web -->|Port 8000 HMAC Token| RAG[Python RAG Microservice\nUID 10001 : raguser\nFastEmbed + Docling]
        RAG -->|Port 5432 pgvector| DB
        RAG -->|Port 6379 Nonce TTL| Redis
    end
```

### Microservice Trust Boundary
Next.js communicates with the Python RAG microservice using **HMAC-SHA256 service assertions** (`typ: INTERNAL_ASSERTION`) with strict 60-second expiration. Distributed replay defense via Redis nonces ensures intercepted assertions cannot be reused.

---

## 📂 Repository Structure

```
MediMate-AI/
├── docker-compose.prod.yaml      # Production container topology (internal-only network)
├── docker-compose.phase9.yaml    # Phase 9 integration verification stack
├── .env.production.example       # Production secret injection template
├── services/
│   └── medimate-rag/             # Python FastAPI RAG Microservice
│       ├── app/
│       │   ├── api/routes/       # Ingest, query, delete, health probes
│       │   ├── chunking/         # Clinical chunking algorithms
│       │   ├── embeddings/       # Local FastEmbed (ONNX) provider
│       │   ├── security/         # HMAC verification & Redis replay protection
│       │   └── storage/          # pgvector and memory vector backends
│       ├── Dockerfile            # Multi-stage hardened Python container
│       ├── requirements.txt
│       └── tests/                # 40 Pytest test suites (100% pass)
└── web/                          # Next.js 14 Web Application
    ├── docker/init-db/           # Role segregation (medimate_owner, medimate_app) & RLS SQL
    ├── prisma/                   # Prisma schema & 5 forward migrations
    ├── src/
    │   ├── app/                  # Next.js App Router (UI & API routes)
    │   ├── lib/
    │   │   ├── clinical/         # Emergency guidance & clinical safety policies
    │   │   ├── encryption/       # AES-256-GCM, key lifecycle, SigV4 KMS adapter
    │   │   ├── backup/           # MM_BAK01 encrypted backup & disaster recovery
    │   │   ├── health-intel/     # Context Engine, Planner, Longitudinal, Memory
    │   │   ├── integration/      # End-to-end integration & production smoke tests
    │   │   ├── rag/              # HMAC client & RAG microservice connector
    │   │   ├── security/         # SecurityAuditLogger & PHI redaction
    │   │   ├── storage/          # LocalStorageDriver (MM_ENC03), RAM scratch
    │   │   └── wearables/        # Normalization, Fitbit/Oura connectors, consent
    └── Dockerfile                # Multi-stage hardened Alpine container
```

---

## 🚀 Quick Start (Local Production Deployment)

### 1. Prerequisites
- [Docker Engine 24+](https://docs.docker.com/engine/) & [Docker Compose v2.20+](https://docs.docker.com/compose/)
- Node.js 20+ (for local development)
- Python 3.12+ (for RAG service local development)

### 2. Configure Production Secrets
Copy `.env.production.example` and set your secure keys:
```bash
cp .env.production.example .env.production
```

Generate 256-bit cryptographically secure keys:
```bash
# Generate random 32-byte hex keys:
openssl rand -hex 32
```
Ensure you set:
- `AUTH_SECRET`: Web session key
- `INTERNAL_SERVICE_SECRET`: HMAC key shared between Web and RAG
- `LOCAL_ENCRYPTION_KEY`: 64-char hex key for document encryption
- `BACKUP_ENCRYPTION_KEY`: 64-char hex key for backup archives
- `DB_ADMIN_PASSWORD`, `DB_APP_PASSWORD`, `DB_OWNER_PASSWORD`, `REDIS_PASSWORD`

### 3. Start Database & Cache
```bash
docker compose -f docker-compose.prod.yaml --env-file .env.production up -d postgres-prod redis-prod
```

### 4. Run Migrations & RLS Policies
```bash
cd web
export MIGRATION_DATABASE_URL="postgresql://medimate_owner:${DB_OWNER_PASSWORD}@127.0.0.1:5444/medimate_prod_db"
export DATABASE_URL="postgresql://medimate_app:${DB_APP_PASSWORD}@127.0.0.1:5444/medimate_prod_db"

npx prisma migrate deploy
node prisma/post-migration-rls.cjs
```

### 5. Launch Full Application Stack
```bash
cd ..
docker compose -f docker-compose.prod.yaml --env-file .env.production up -d --build
```

### 6. Verify Health & Readiness
```bash
# Web application readiness probe
curl -s http://127.0.0.1:3008/api/health/ready

# Python RAG microservice liveness probe
docker compose -f docker-compose.prod.yaml exec medimate-rag-prod \
  python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/health/live').read().decode())"
```

The web application is available at `http://127.0.0.1:3008`.

---

## 🧪 Testing & Quality Assurance

MediMate AI includes a comprehensive test suite across unit, integration, and security layers:

```bash
# 1. Run Web Unit & Integration Tests (Vitest)
cd web
npm test

# 2. Run Phase 10 Production Smoke Suite
npx vitest run src/lib/integration/__tests__/phase10-production-smoke.test.ts

# 3. Run All Integration Suites (Scenarios A-H, Multi-Tenant, Disaster Recovery)
npx vitest run src/lib/integration/__tests__/

# 4. Run Python RAG Microservice Tests (Pytest)
cd ../services/medimate-rag
pytest
```

| Test Suite | Tests | Result | Focus Area |
| :--- | :---: | :---: | :--- |
| `phase10-production-smoke.test.ts` | 12 | **100% PASS** | End-to-end production smoke drill |
| `phase9-user-journeys.test.ts` | 8 | **100% PASS** | User journey Scenarios A through H |
| `phase9-multi-tenant-security.test.ts` | 4 | **100% PASS** | Cross-tenant boundaries (Alpha, Beta, Gamma) |
| `phase9-encryption-and-providers.test.ts` | 3 | **100% PASS** | AAD binding & fail-closed mobile stubs |
| `phase9-disaster-recovery.test.ts` | 2 | **100% PASS** | MM_BAK01 archive integrity & restoration |
| Python RAG Microservice (`tests/`) | 40 | **100% PASS** | pgvector, FastEmbed, replay defense, chunking |

---

## 🔒 Security & Privacy Guarantees

1. **Local-First Architecture:** By default (`MEDIMATE_DEPLOYMENT_MODE=LOCAL`), sensitive medical records and conversational queries never leave your local infrastructure.
2. **Encrypted Storage:** Documents are encrypted before being written to disk using AES-256-GCM. Unencrypted plaintext touches only RAM-backed scratch mounts (`tmpfs`).
3. **No Root Containers:** All production containers run under unprivileged non-root users (`UID 10001`).
4. **Structured Redaction:** Passwords, API keys, Bearer tokens, and clinical document contents are automatically scrubbed from operational logs.
5. **Fail-Closed Boundaries:** Unconsented wearable categories, unconfigured cloud KMS, or tampered HMAC tokens immediately fail closed.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
