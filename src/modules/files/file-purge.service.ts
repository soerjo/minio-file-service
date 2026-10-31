import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { FilesRepository } from './files.repository.js';
import { MinioService } from './minio.service.js';
import {
  DEFAULT_PENDING_FILE_CLEANUP_CRON,
  PURGE_BATCH_SIZE,
} from './files.constants.js';
export interface PurgeSummary {
  scanned: number;
  purged: number;
  bytes: number;
}

export const PENDING_FILE_CLEANUP_JOB_NAME = 'pending-file-cleanup';

@Injectable()
export class FilePurgeService implements OnModuleInit {
  private readonly logger = new Logger(FilePurgeService.name);

  constructor(
    private readonly filesRepository: FilesRepository,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const cronExpression = this.configService.get<string>(
      'PENDING_FILE_CLEANUP_CRON',
      DEFAULT_PENDING_FILE_CLEANUP_CRON,
    );
    const job = CronJob.from({
      cronTime: cronExpression,
      onTick: async () => {
        await this.handleCron();
      },
      start: false,
    });
    this.schedulerRegistry.addCronJob(PENDING_FILE_CLEANUP_JOB_NAME, job);
    job.start();
    this.logger.log(
      `Scheduled pending file cleanup with cron expression "${cronExpression}"`,
    );
  }

  async handleCron(): Promise<void> {
    await this.purgeExpiredPending();
  }

  /**
   * Permanently removes expired pending uploads after the configured confirmation window
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
