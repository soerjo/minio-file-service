import type { FileUpload } from '@prisma/client';
import { FilesService, type UploadedFile } from './files.service.js';
import type { FilesRepository } from './files.repository.js';
import type { MinioService } from './minio.service.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { AppError } from '../../common/errors/app-error.js';
import {
  MAX_FILE_SIZE_BYTES,
  MAX_LIST_LIMIT,
  UPLOAD_PENDING_TTL_MS,
} from './files.constants.js';

const helloSha256 =
  '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

const user: AuthUser = {
  id: 'user-1',
  email: 'user@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
  role: 'USER',
  organizationId: 'org-1',
};

const admin: AuthUser = { ...user, id: 'admin-1', role: 'ADMIN' };

const filesRepository = {
  create: jest.fn(),
  findById: jest.fn(),
  findManyByIds: jest.fn(),
  findMany: jest.fn(),
  count: jest.fn(),
  confirmMany: jest.fn(),
  softDelete: jest.fn(),
  softDeleteByEntityExcept: jest.fn(),
} as unknown as jest.Mocked<FilesRepository>;

const minioService = {
  bucketName: 'app-uploads',
  putObject: jest.fn(),
  presignedGetObject: jest.fn(),
  removeObject: jest.fn(),
} as unknown as jest.Mocked<MinioService>;

async function expectAppError(
  promise: Promise<unknown>,
  expectedCode: string,
): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error('Expected the call to reject, but it resolved');
    },
    (rejection: unknown) => rejection,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(expectedCode);
}

function makeFileRow(overrides: Partial<FileUpload> = {}): FileUpload {
  return {
    id: 'file-1',
    bucket: 'app-uploads',
    objectKey: 'user-1/7c1b9d0e-2f4a-4c6e-8a0b-9c8d7e6f5a4b-Invoice-42-EU.pdf',
    originalName: 'Invoice 42 EU.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 5,
    checksum: helloSha256,
    status: 'PENDING',
    expiresAt: new Date('2026-10-14T09:15:00.000Z'),
    confirmedAt: null,
    entityType: null,
    entityId: null,
    isDeleted: false,
    deletedAt: null,
    deletedBy: null,
    uploadedBy: 'user-1',
    createdAt: new Date('2026-10-13T09:15:00.000Z'),
    updatedAt: new Date('2026-10-13T09:15:00.000Z'),
    ...overrides,
  };
}

function makeUploadedFile(overrides: Partial<UploadedFile> = {}): UploadedFile {
  return {
    originalname: 'Invoice 42 EU.pdf',
    mimetype: 'application/pdf',
    size: 5,
    buffer: Buffer.from('hello'),
    ...overrides,
  };
}

describe('FilesService', () => {
  let service: FilesService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new FilesService(filesRepository, minioService);
  });

  describe('upload', () => {
    it('stores the object first, then creates pending metadata that expires in 24 hours', async () => {
      minioService.putObject.mockResolvedValue(undefined);
      filesRepository.create.mockImplementation((data) =>
        Promise.resolve(
          makeFileRow({
            objectKey: data.objectKey,
            status: data.status as string,
            expiresAt: data.expiresAt as Date,
            entityType: data.entityType as string | null,
            entityId: data.entityId as string | null,
          }),
        ),
      );

      const before = Date.now();
      const result = await service.upload(makeUploadedFile(), user, {
        entityType: 'invoice',
        entityId: 'invoice-123',
      });
      const after = Date.now();

      const objectKey = minioService.putObject.mock.calls[0][0];
      expect(objectKey).toMatch(/^user-1\/[0-9a-f-]{36}-Invoice-42-EU\.pdf$/);
      expect(minioService.putObject).toHaveBeenCalledWith(
        objectKey,
        Buffer.from('hello'),
        5,
        'application/pdf',
      );
      const createData = filesRepository.create.mock.calls[0][0];
      expect(createData).toMatchObject({
        bucket: 'app-uploads',
        objectKey,
        originalName: 'Invoice 42 EU.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 5,
        checksum: helloSha256,
        status: 'PENDING',
        entityType: 'invoice',
        entityId: 'invoice-123',
        uploadedBy: 'user-1',
      });
      expect((createData.expiresAt as Date).getTime()).toBeGreaterThanOrEqual(
        before + UPLOAD_PENDING_TTL_MS,
      );
      expect((createData.expiresAt as Date).getTime()).toBeLessThanOrEqual(
        after + UPLOAD_PENDING_TTL_MS,
      );
      expect(result.status).toBe('PENDING');
      expect(result.expiresAt).not.toBeNull();
      expect(result.entityType).toBe('invoice');
      expect(result.entityId).toBe('invoice-123');
    });

    it('stores null entity tags when no upload metadata is provided', async () => {
      minioService.putObject.mockResolvedValue(undefined);
      filesRepository.create.mockImplementation((data) =>
        Promise.resolve(makeFileRow({ objectKey: data.objectKey })),
      );

      await service.upload(makeUploadedFile(), user);

      expect(filesRepository.create.mock.calls[0][0]).toMatchObject({
        entityType: null,
        entityId: null,
      });
    });

    it('rejects a non-whitelisted extension and MIME type with 415', async () => {
      await expectAppError(
        service.upload(
          makeUploadedFile({
            originalname: 'evil.exe',
            mimetype: 'application/x-msdownload',
          }),
          user,
        ),
        'UNSUPPORTED_MEDIA_TYPE',
      );
      expect(minioService.putObject).not.toHaveBeenCalled();
      expect(filesRepository.create).not.toHaveBeenCalled();
    });

    it('rejects a whitelisted extension with a mismatched MIME type', async () => {
      await expectAppError(
        service.upload(
          makeUploadedFile({
            originalname: 'photo.png',
            mimetype: 'image/jpeg',
          }),
          user,
        ),
        'UNSUPPORTED_MEDIA_TYPE',
      );
      expect(minioService.putObject).not.toHaveBeenCalled();
    });

    it('rejects an oversized file with 413', async () => {
      await expectAppError(
        service.upload(
          makeUploadedFile({ size: MAX_FILE_SIZE_BYTES + 1 }),
          user,
        ),
        'FILE_TOO_LARGE',
      );
      expect(minioService.putObject).not.toHaveBeenCalled();
    });

    it('rejects a missing file with VALIDATION_ERROR', async () => {
      await expectAppError(service.upload(undefined, user), 'VALIDATION_ERROR');
    });

    it('maps a MinIO failure to MINIO_UNAVAILABLE without touching the DB', async () => {
      minioService.putObject.mockRejectedValue(new Error('ECONNREFUSED'));

      await expectAppError(
        service.upload(makeUploadedFile(), user),
        'MINIO_UNAVAILABLE',
      );
      expect(filesRepository.create).not.toHaveBeenCalled();
      expect(minioService.removeObject).not.toHaveBeenCalled();
    });

    it('compensates with removeObject when the PG insert fails', async () => {
      minioService.putObject.mockResolvedValue(undefined);
      filesRepository.create.mockRejectedValue(new Error('insert failed'));

      await expect(service.upload(makeUploadedFile(), user)).rejects.toThrow(
        'insert failed',
      );

      expect(minioService.removeObject).toHaveBeenCalledWith(
        minioService.putObject.mock.calls[0][0],
      );
    });
  });

  describe('list', () => {
    it('scopes non-ADMIN users to their own non-deleted uploads', async () => {
      filesRepository.findMany.mockResolvedValue([makeFileRow()]);
      filesRepository.count.mockResolvedValue(1);

      const result = await service.list({ page: 1, limit: 20 }, user);

      const params = filesRepository.findMany.mock.calls[0][0];
      expect(params.where).toEqual({ isDeleted: false, uploadedBy: 'user-1' });
      expect(filesRepository.count).toHaveBeenCalledWith(params.where);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('lists all non-deleted uploads for ADMIN users', async () => {
      filesRepository.findMany.mockResolvedValue([]);
      filesRepository.count.mockResolvedValue(0);

      await service.list({ page: 1, limit: 20 }, admin);

      expect(filesRepository.findMany.mock.calls[0][0].where).toEqual({
        isDeleted: false,
      });
    });

    it('passes PENDING and CONFIRMED statuses through the list result', async () => {
      filesRepository.findMany.mockResolvedValue([
        makeFileRow({ id: 'file-pending', status: 'PENDING' }),
        makeFileRow({
          id: 'file-confirmed',
          status: 'CONFIRMED',
          expiresAt: null,
          confirmedAt: new Date('2026-10-13T10:00:00.000Z'),
        }),
      ]);
      filesRepository.count.mockResolvedValue(2);

      const result = await service.list({ page: 1, limit: 20 }, user);

      expect(result.items.map((item) => item.status)).toEqual([
        'PENDING',
        'CONFIRMED',
      ]);
    });

    it('applies search, limit clamp, skip, and sort mapping', async () => {
      filesRepository.findMany.mockResolvedValue([]);
      filesRepository.count.mockResolvedValue(0);

      const result = await service.list(
        { page: 3, limit: 500, search: 'invoIce', sort: 'size:desc' },
        user,
      );

      const params = filesRepository.findMany.mock.calls[0][0];
      expect(params.where).toEqual({
        isDeleted: false,
        uploadedBy: 'user-1',
        originalName: { contains: 'invoIce', mode: 'insensitive' },
      });
      expect(params.skip).toBe(200);
      expect(params.take).toBe(MAX_LIST_LIMIT);
      expect(params.orderBy).toEqual({ sizeBytes: 'desc' });
      expect(result.limit).toBe(MAX_LIST_LIMIT);
    });

    it('defaults sort and rejects invalid sort values', async () => {
      filesRepository.findMany.mockResolvedValue([]);
      filesRepository.count.mockResolvedValue(0);

      await service.list({ page: 1, limit: 20 }, user);
      expect(filesRepository.findMany.mock.calls[0][0].orderBy).toEqual({
        createdAt: 'desc',
      });

      await expectAppError(
        service.list({ page: 1, limit: 20, sort: 'bogus:asc' }, user),
        'VALIDATION_ERROR',
      );
    });
  });

  describe('getById and presigned urls', () => {
    it('returns owner and admin accessible files', async () => {
      filesRepository.findById.mockResolvedValue(makeFileRow());
      await expect(service.getById('file-1', user)).resolves.toMatchObject({
        id: 'file-1',
      });

      filesRepository.findById.mockResolvedValue(
        makeFileRow({ uploadedBy: 'someone-else' }),
      );
      await expect(service.getById('file-1', admin)).resolves.toMatchObject({
        id: 'file-1',
      });
    });

    it('returns FILE_NOT_FOUND for missing, deleted, or inaccessible files', async () => {
      filesRepository.findById.mockResolvedValue(null);
      await expectAppError(service.getById('missing', user), 'FILE_NOT_FOUND');

      filesRepository.findById.mockResolvedValue(
        makeFileRow({ isDeleted: true, deletedAt: new Date() }),
      );
      await expectAppError(service.getById('file-1', user), 'FILE_NOT_FOUND');

      filesRepository.findById.mockResolvedValue(
        makeFileRow({ uploadedBy: 'someone-else' }),
      );
      await expectAppError(service.getById('file-1', user), 'FILE_NOT_FOUND');
    });

    it('presigns against the row bucket and maps storage failures', async () => {
      filesRepository.findById.mockResolvedValue(
        makeFileRow({ bucket: 'test', objectKey: 'Gemini_x.png' }),
      );
      minioService.presignedGetObject.mockResolvedValue(
        'http://localhost:9100/test/Gemini_x.png?X-Amz-Expires=900',
      );

      const result = await service.getPresignedUrl('file-1', user);

      expect(minioService.presignedGetObject).toHaveBeenCalledWith(
        'Gemini_x.png',
        900,
        'test',
      );
      expect(result.url).toContain('Gemini_x.png');

      minioService.presignedGetObject.mockRejectedValue(new Error('boom'));
      await expectAppError(
        service.getPresignedUrl('file-1', user),
        'MINIO_UNAVAILABLE',
      );
    });
  });

  describe('remove', () => {
    it('soft-deletes and returns the updated file without touching MinIO', async () => {
      filesRepository.findById
        .mockResolvedValueOnce(makeFileRow())
        .mockResolvedValueOnce(
          makeFileRow({
            isDeleted: true,
            deletedAt: new Date('2026-10-13T09:20:00.000Z'),
            deletedBy: user.id,
          }),
        );
      filesRepository.softDelete.mockResolvedValue(1);

      const result = await service.remove('file-1', user);

      expect(filesRepository.softDelete).toHaveBeenCalledWith(
        'file-1',
        user.id,
      );
      expect(result.isDeleted).toBe(true);
      expect(minioService.removeObject).not.toHaveBeenCalled();
    });

    it('rejects repeat delete or a guarded update miss with FILE_NOT_FOUND', async () => {
      filesRepository.findById.mockResolvedValue(
        makeFileRow({ isDeleted: true, deletedAt: new Date() }),
      );
      await expectAppError(service.remove('file-1', user), 'FILE_NOT_FOUND');

      filesRepository.findById.mockResolvedValue(makeFileRow());
      filesRepository.softDelete.mockResolvedValue(0);
      await expectAppError(service.remove('file-1', user), 'FILE_NOT_FOUND');
    });
  });

  describe('confirm', () => {
    it('confirms owned files and applies optional entity tags', async () => {
      filesRepository.findManyByIds.mockResolvedValue([
        makeFileRow({ id: 'file-1' }),
        makeFileRow({ id: 'file-2' }),
      ]);
      filesRepository.confirmMany.mockResolvedValue([
        makeFileRow({
          id: 'file-1',
          status: 'CONFIRMED',
          expiresAt: null,
          confirmedAt: new Date('2026-10-13T10:00:00.000Z'),
          entityType: 'invoice',
          entityId: 'invoice-123',
        }),
        makeFileRow({
          id: 'file-2',
          status: 'CONFIRMED',
          expiresAt: null,
          confirmedAt: new Date('2026-10-13T10:00:00.000Z'),
          entityType: 'invoice',
          entityId: 'invoice-123',
        }),
      ]);

      const result = await service.confirm(
        {
          fileIds: ['file-1', 'file-2', 'file-1'],
          entityType: 'invoice',
          entityId: 'invoice-123',
        },
        user,
      );

      expect(filesRepository.findManyByIds).toHaveBeenCalledWith([
        'file-1',
        'file-2',
      ]);
      const confirmArgs = filesRepository.confirmMany.mock.calls[0][0];
      expect(confirmArgs).toMatchObject({
        ids: ['file-1', 'file-2'],
        entityType: 'invoice',
        entityId: 'invoice-123',
      });
      expect(confirmArgs.confirmedAt).toBeInstanceOf(Date);
      expect(result.map((file) => file.status)).toEqual([
        'CONFIRMED',
        'CONFIRMED',
      ]);
      expect(result[0].expiresAt).toBeNull();
      expect(result[0].confirmedAt).not.toBeNull();
    });

    it('rejects missing or inaccessible files', async () => {
      filesRepository.findManyByIds.mockResolvedValue([makeFileRow()]);
      await expectAppError(
        service.confirm({ fileIds: ['file-1', 'missing'] }, user),
        'FILE_NOT_FOUND',
      );

      filesRepository.findManyByIds.mockResolvedValue([
        makeFileRow({ uploadedBy: 'someone-else' }),
      ]);
      await expectAppError(
        service.confirm({ fileIds: ['file-1'] }, user),
        'FILE_NOT_FOUND',
      );
    });
  });

  describe('reconcile', () => {
    it('confirms active ids for the entity and soft-deletes stale entity files', async () => {
      filesRepository.findManyByIds.mockResolvedValue([
        makeFileRow({ id: 'file-1' }),
      ]);
      filesRepository.confirmMany.mockResolvedValue([
        makeFileRow({
          id: 'file-1',
          status: 'CONFIRMED',
          expiresAt: null,
          confirmedAt: new Date('2026-10-13T10:00:00.000Z'),
          entityType: 'invoice',
          entityId: 'invoice-123',
        }),
      ]);
      filesRepository.softDeleteByEntityExcept.mockResolvedValue(3);

      const result = await service.reconcile(
        {
          entityType: 'invoice',
          entityId: 'invoice-123',
          activeFileIds: ['file-1'],
        },
        user,
      );

      const confirmArgs = filesRepository.confirmMany.mock.calls[0][0];
      expect(confirmArgs).toMatchObject({
        ids: ['file-1'],
        entityType: 'invoice',
        entityId: 'invoice-123',
      });
      expect(confirmArgs.confirmedAt).toBeInstanceOf(Date);
      expect(filesRepository.softDeleteByEntityExcept).toHaveBeenCalledWith({
        entityType: 'invoice',
        entityId: 'invoice-123',
        exceptIds: ['file-1'],
        deletedBy: 'user-1',
        uploadedBy: 'user-1',
      });
      expect(result.softDeleted).toBe(3);
      expect(result.confirmed[0].status).toBe('CONFIRMED');
    });

    it('lets admins reconcile all files for an entity', async () => {
      filesRepository.findManyByIds.mockResolvedValue([
        makeFileRow({ id: 'file-1', uploadedBy: 'someone-else' }),
      ]);
      filesRepository.confirmMany.mockResolvedValue([
        makeFileRow({ id: 'file-1', status: 'CONFIRMED' }),
      ]);
      filesRepository.softDeleteByEntityExcept.mockResolvedValue(0);

      await service.reconcile(
        {
          entityType: 'invoice',
          entityId: 'invoice-123',
          activeFileIds: ['file-1'],
        },
        admin,
      );

      expect(filesRepository.softDeleteByEntityExcept).toHaveBeenCalledWith({
        entityType: 'invoice',
        entityId: 'invoice-123',
        exceptIds: ['file-1'],
        deletedBy: 'admin-1',
        uploadedBy: undefined,
      });
    });

    it('supports an empty active list by deleting prior entity files only', async () => {
      filesRepository.findManyByIds.mockResolvedValue([]);
      filesRepository.confirmMany.mockResolvedValue([]);
      filesRepository.softDeleteByEntityExcept.mockResolvedValue(2);

      const result = await service.reconcile(
        { entityType: 'invoice', entityId: 'invoice-123', activeFileIds: [] },
        user,
      );

      const confirmArgs = filesRepository.confirmMany.mock.calls[0][0];
      expect(confirmArgs).toMatchObject({
        ids: [],
        entityType: 'invoice',
        entityId: 'invoice-123',
      });
      expect(confirmArgs.confirmedAt).toBeInstanceOf(Date);
      expect(result).toEqual({ confirmed: [], softDeleted: 2 });
    });
  });
});
