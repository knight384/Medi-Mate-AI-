-- CreateTable
CREATE TABLE "WearableConnection" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "encrypted_access_token" TEXT NOT NULL,
    "encrypted_refresh_token" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "scope" TEXT NOT NULL DEFAULT '',
    "external_user_id" TEXT,
    "last_sync_at" TIMESTAMP(3),
    "last_sync_status" TEXT,
    "sync_cursor" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WearableConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WearableConsent" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "categories" JSONB NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WearableConsent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WearableConnection_user_id_provider_id_key" ON "WearableConnection"("user_id", "provider_id");

-- CreateIndex
CREATE INDEX "WearableConnection_user_id_idx" ON "WearableConnection"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "WearableConsent_user_id_provider_id_key" ON "WearableConsent"("user_id", "provider_id");

-- CreateIndex
CREATE INDEX "WearableConsent_user_id_idx" ON "WearableConsent"("user_id");

-- CreateIndex
CREATE INDEX "HealthData_authorId_type_idx" ON "HealthData"("authorId", "type");

-- AddForeignKey
ALTER TABLE "WearableConnection" ADD CONSTRAINT "WearableConnection_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WearableConsent" ADD CONSTRAINT "WearableConsent_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable and Force Row Level Security
ALTER TABLE "WearableConnection" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WearableConnection" FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'WearableConnection' AND policyname = 'WearableConnection_isolation_policy'
    ) THEN
        CREATE POLICY "WearableConnection_isolation_policy" ON "WearableConnection"
            FOR ALL
            USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), ''));
    END IF;
END $$;

ALTER TABLE "WearableConsent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WearableConsent" FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'WearableConsent' AND policyname = 'WearableConsent_isolation_policy'
    ) THEN
        CREATE POLICY "WearableConsent_isolation_policy" ON "WearableConsent"
            FOR ALL
            USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), ''));
    END IF;
END $$;
