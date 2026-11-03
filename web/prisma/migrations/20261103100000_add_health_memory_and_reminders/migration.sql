-- CreateTable
CREATE TABLE "UserHealthMemory" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "source_type" TEXT NOT NULL DEFAULT 'USER_EXPLICIT',
    "source_id" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "is_paused" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserHealthMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthReminder" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "schedule_type" TEXT NOT NULL,
    "schedule_time" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_triggered_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthReminder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserHealthMemory_user_id_category_idx" ON "UserHealthMemory"("user_id", "category");

-- CreateIndex
CREATE INDEX "UserHealthMemory_user_id_key_idx" ON "UserHealthMemory"("user_id", "key");

-- CreateIndex
CREATE INDEX "HealthReminder_user_id_is_enabled_idx" ON "HealthReminder"("user_id", "is_enabled");

-- AddForeignKey
ALTER TABLE "UserHealthMemory" ADD CONSTRAINT "UserHealthMemory_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthReminder" ADD CONSTRAINT "HealthReminder_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enable and Force Row Level Security for UserHealthMemory
ALTER TABLE "UserHealthMemory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UserHealthMemory" FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'UserHealthMemory' AND policyname = 'UserHealthMemory_isolation_policy'
    ) THEN
        CREATE POLICY "UserHealthMemory_isolation_policy" ON "UserHealthMemory"
            FOR ALL
            USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), ''));
    END IF;
END $$;

-- Enable and Force Row Level Security for HealthReminder
ALTER TABLE "HealthReminder" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "HealthReminder" FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'HealthReminder' AND policyname = 'HealthReminder_isolation_policy'
    ) THEN
        CREATE POLICY "HealthReminder_isolation_policy" ON "HealthReminder"
            FOR ALL
            USING ("user_id" = NULLIF(current_setting('app.current_user_id', true), ''));
    END IF;
END $$;
