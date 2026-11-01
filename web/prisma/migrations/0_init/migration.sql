-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('USER', 'ASSISTANT');

-- CreateEnum
CREATE TYPE "AssistantModeVisibility" AS ENUM ('PUBLIC', 'PRIVATE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "hasOnboarded" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuth2Client" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT NOT NULL,
    "client_id_issued_at" INTEGER NOT NULL DEFAULT 0,
    "client_secret_expires_at" INTEGER NOT NULL DEFAULT 0,
    "client_metadata" TEXT NOT NULL,

    CONSTRAINT "OAuth2Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuth2AuthorizationCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL DEFAULT '',
    "response_type" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT '',
    "nonce" TEXT,
    "auth_time" INTEGER NOT NULL,
    "code_challenge" TEXT,
    "code_challenge_method" TEXT,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "OAuth2AuthorizationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OAuth2Token" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "token_type" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "scope" TEXT NOT NULL DEFAULT '',
    "issued_at" INTEGER NOT NULL,
    "access_token_revoked_at" INTEGER NOT NULL DEFAULT 0,
    "refresh_token_revoked_at" INTEGER NOT NULL DEFAULT 0,
    "expires_in" INTEGER NOT NULL DEFAULT 0,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "OAuth2Token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealthData" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "authorId" TEXT,
    "metadata" JSONB,
    "filePath" TEXT,
    "fileType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'COMPLETED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HealthData_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatRoom" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "assistantModeId" TEXT NOT NULL,
    "llmProviderId" TEXT NOT NULL,
    "llmProviderModelId" TEXT,
    "authorId" TEXT,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "chatRoomId" TEXT NOT NULL,
    "role" "ChatRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantMode" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "visibility" "AssistantModeVisibility" NOT NULL DEFAULT 'PRIVATE',
    "authorId" TEXT,
    "llmProviderId" TEXT,
    "llmProviderModelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantMode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantModeContext" (
    "id" TEXT NOT NULL,
    "assistantModeId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantModeContext_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LLMProvider" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL DEFAULT '',
    "apiURL" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LLMProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RedditAccessToken" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "tokenType" TEXT NOT NULL,
    "expiresIn" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RedditAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RedditPost" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isMedicalAdviceRequired" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RedditPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RedditPostComment" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "assistantModeId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RedditPostComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "OAuth2Client_client_id_idx" ON "OAuth2Client"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "OAuth2AuthorizationCode_code_key" ON "OAuth2AuthorizationCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "OAuth2Token_access_token_key" ON "OAuth2Token"("access_token");

-- CreateIndex
CREATE INDEX "OAuth2Token_refresh_token_idx" ON "OAuth2Token"("refresh_token");

-- CreateIndex
CREATE INDEX "RedditAccessToken_username_expiresAt_idx" ON "RedditAccessToken"("username", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "RedditPost_postId_key" ON "RedditPost"("postId");

-- CreateIndex
CREATE UNIQUE INDEX "RedditPostComment_commentId_key" ON "RedditPostComment"("commentId");

-- AddForeignKey
ALTER TABLE "OAuth2Client" ADD CONSTRAINT "OAuth2Client_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuth2AuthorizationCode" ADD CONSTRAINT "OAuth2AuthorizationCode_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OAuth2Token" ADD CONSTRAINT "OAuth2Token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealthData" ADD CONSTRAINT "HealthData_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatRoom" ADD CONSTRAINT "ChatRoom_assistantModeId_fkey" FOREIGN KEY ("assistantModeId") REFERENCES "AssistantMode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatRoom" ADD CONSTRAINT "ChatRoom_llmProviderId_fkey" FOREIGN KEY ("llmProviderId") REFERENCES "LLMProvider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatRoom" ADD CONSTRAINT "ChatRoom_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_chatRoomId_fkey" FOREIGN KEY ("chatRoomId") REFERENCES "ChatRoom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantMode" ADD CONSTRAINT "AssistantMode_llmProviderId_fkey" FOREIGN KEY ("llmProviderId") REFERENCES "LLMProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantMode" ADD CONSTRAINT "AssistantMode_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantModeContext" ADD CONSTRAINT "AssistantModeContext_assistantModeId_fkey" FOREIGN KEY ("assistantModeId") REFERENCES "AssistantMode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LLMProvider" ADD CONSTRAINT "LLMProvider_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedditPostComment" ADD CONSTRAINT "RedditPostComment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "RedditPost"("postId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RedditPostComment" ADD CONSTRAINT "RedditPostComment_assistantModeId_fkey" FOREIGN KEY ("assistantModeId") REFERENCES "AssistantMode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
