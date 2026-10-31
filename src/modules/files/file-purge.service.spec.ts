jest.mock('@nestjs/schedule', () => ({
  Cron: () => () => undefined,
}));

import type { FileUpload } from '@prisma/client';
import { FilePurgeService } from './file-purge.service.js';
import type { FilesRepository } from './files.repository.js';
import type { MinioService } from './minio.service.js';
import { PURGE_BATCH_SIZE } from './files.constants.js';

const filesRepository = {
  findExpiredPending: jest.fn(),
  hardDelete: jest.fn(),
} as unknown as jest.Mocked<FilesRepository>;

const minioService = {
  removeObject: jest.fn(),
} as unknown as jest.Mocked<MinioService>;

function makeFileRow(overrides: Partial<FileUpload> = {}): FileUpload {
  return {
    id: 'file-1',
    bucket: 'app-uploads',
    objectKey: 'user-1/key.pdf',
    originalName: 'key.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 5,
    checksum: 'a'.repeat(64),
    status: 'PENDING',
    expiresAt: new Date('2026-10-14T00:00:00.000Z'),
    confirmedAt: null,
    entityType: null,
    entityId: null,
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
    uploadedBy: 'user-1',
    createdAt: new Date('2026-10-13T00:00:00.000Z'),
    updatedAt: new Date('2026-10-13T00:00:00.000Z'),
    ...overrides,
  };
}

describe('FilePurgeService', () => {
  let service: FilePurgeService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new FilePurgeService(filesRepository, minioService);
  });

  it('removes expired pending objects from their row bucket before hard-deleting rows', async () => {
    const now = new Date('2026-10-15T00:00:00.000Z');
    filesRepository.findExpiredPending
      .mockResolvedValueOnce([
        makeFileRow({ id: 'file-1', bucket: 'app-uploads', sizeBytes: 5 }),
        makeFileRow({
          id: 'file-2',
          bucket: 'legacy-bucket',
          objectKey: 'legacy/key.pdf',
          sizeBytes: 7,
        }),
      ])
      .mockResolvedValueOnce([]);
    minioService.removeObject.mockResolvedValue(undefined);
    filesRepository.hardDelete.mockResolvedValue(undefined);

    const result = await service.purgeExpiredPending(now);

    expect(filesRepository.findExpiredPending).toHaveBeenCalledWith(
      now,
      PURGE_BATCH_SIZE,
    );
    expect(minioService.removeObject).toHaveBeenCalledWith(
      'user-1/key.pdf',
      'app-uploads',
    );
    expect(minioService.removeObject).toHaveBeenCalledWith(
      'legacy/key.pdf',
      'legacy-bucket',
    );
    expect(filesRepository.hardDelete).toHaveBeenCalledWith('file-1');
    expect(filesRepository.hardDelete).toHaveBeenCalledWith('file-2');
    expect(result).toEqual({ scanned: 2, purged: 2, bytes: 12 });
  });

  it('leaves the DB row for retry when object removal fails', async () => {
    filesRepository.findExpiredPending.mockResolvedValueOnce([makeFileRow()]);
    minioService.removeObject.mockRejectedValue(new Error('minio down'));

    const result = await service.purgeExpiredPending(
      new Date('2026-10-15T00:00:00.000Z'),
    );

    expect(filesRepository.hardDelete).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 1, purged: 0, bytes: 0 });
  });

  it('cron delegates to expired pending cleanup', async () => {
    const purgeSpy = jest
      .spyOn(service, 'purgeExpiredPending')
      .mockResolvedValue({ scanned: 0, purged: 0, bytes: 0 });

    await service.handleCron();

    expect(purgeSpy).toHaveBeenCalledTimes(1);
  });
});
