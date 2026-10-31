import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { FilesRepository } from './files.repository.js';
import { MinioService } from './minio.service.js';
import { PURGE_BATCH_SIZE } from './files.constants.js';
export interface PurgeSummary {
  scanned: number;
  purged: number;
  bytes: number;
}

@Injectable()
export class FilePurgeService {
  private readonly logger = new Logger(FilePurgeService.name);

  constructor(
    private readonly filesRepository: FilesRepository,
    private readonly minioService: MinioService,
  ) {}

  @Cron('0 0 * * *')
  async handleCron(): Promise<void> {
    await this.purgeExpiredPending();
  }

  /**
   * Permanently removes pending uploads whose 24-hour confirmation window
   * elapsed. The MinIO object is removed before the metadata row, so storage
   * failures leave the row eligible for the next cleanup run.
   */
  async purgeExpiredPending(now: Date = new Date()): Promise<PurgeSummary> {
    const summary: PurgeSummary = { scanned: 0, purged: 0, bytes: 0 };

    while (true) {
      const batch = await this.filesRepository.findExpiredPending(
        now,
        PURGE_BATCH_SIZE,
      );
      if (batch.length === 0) {
        break;
      }
      summary.scanned += batch.length;

      let purgedInBatch = 0;
      for (const file of batch) {
        try {
          await this.minioService.removeObject(file.objectKey, file.bucket);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Failed to remove expired pending object ${file.bucket}/${file.objectKey}: ${reason}`,
          );
          continue;
        }
        await this.filesRepository.hardDelete(file.id);
        purgedInBatch += 1;
        summary.purged += 1;
        summary.bytes += file.sizeBytes;
      }

      if (batch.length < PURGE_BATCH_SIZE || purgedInBatch === 0) {
        break;
      }
    }

    this.logger.log(
      `Expired pending cleanup complete: count=${summary.purged} bytes=${summary.bytes}`,
    );
    return summary;
  }
}
