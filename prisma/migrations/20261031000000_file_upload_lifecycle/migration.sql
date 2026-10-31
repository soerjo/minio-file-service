-- Add pending/confirmed lifecycle metadata for file uploads.
ALTER TABLE "file_uploads"
  ADD COLUMN "expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "confirmed_at" TIMESTAMPTZ(6),
  ADD COLUMN "entity_type" TEXT,
  ADD COLUMN "entity_id" TEXT;

ALTER TABLE "file_uploads" ALTER COLUMN "status" SET DEFAULT 'PENDING';

ALTER TABLE "file_uploads" DROP CONSTRAINT "file_uploads_status_check";
ALTER TABLE "file_uploads" ADD CONSTRAINT "file_uploads_status_check" CHECK ("status" IN ('ACTIVE', 'DELETED', 'ORPHAN', 'PENDING', 'CONFIRMED'));

CREATE INDEX "file_uploads_status_expires_at_idx" ON "file_uploads"("status", "expires_at");
