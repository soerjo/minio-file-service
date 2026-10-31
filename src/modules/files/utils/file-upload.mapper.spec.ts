import type { FileUpload } from '@prisma/client';
import { toFileUploadDto } from './file-upload.mapper.js';

describe('toFileUploadDto', () => {
  it('maps all API fields, renaming sizeBytes to size', () => {
    const createdAt = new Date('2026-10-13T09:15:00.000Z');
    const updatedAt = new Date('2026-10-13T09:20:00.000Z');
    const expiresAt = new Date('2026-10-14T09:15:00.000Z');
    const row: FileUpload = {
      id: 'file-1',
      bucket: 'app-uploads',
      objectKey: 'user-1/7c1b9d0e-Invoice.pdf',
      originalName: 'Invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 1024,
      checksum: 'a'.repeat(64),
      status: 'PENDING',
      expiresAt,
      confirmedAt: null,
      entityType: 'invoice',
      entityId: 'invoice-123',
      isDeleted: false,
      deletedAt: null,
      deletedBy: null,
      uploadedBy: 'user-1',
      createdAt,
      updatedAt,
    };

    expect(toFileUploadDto(row)).toEqual({
      id: 'file-1',
      bucket: 'app-uploads',
      objectKey: 'user-1/7c1b9d0e-Invoice.pdf',
      originalName: 'Invoice.pdf',
      mimeType: 'application/pdf',
      size: 1024,
      checksum: 'a'.repeat(64),
      status: 'PENDING',
      isDeleted: false,
      deletedAt: null,
      deletedBy: null,
      expiresAt: expiresAt.toISOString(),
      confirmedAt: null,
      entityType: 'invoice',
      entityId: 'invoice-123',
      uploadedBy: 'user-1',
      createdAt,
      updatedAt,
    });
  });

  it('passes confirmation and deletion metadata through', () => {
    const deletedAt = new Date('2026-10-14T10:00:00.000Z');
    const confirmedAt = new Date('2026-10-13T10:00:00.000Z');
    const row: FileUpload = {
      id: 'file-2',
      bucket: 'app-uploads',
      objectKey: 'user-1/9f2c1a3b-Report.pdf',
      originalName: 'Report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      checksum: 'b'.repeat(64),
      status: 'CONFIRMED',
      expiresAt: null,
      confirmedAt,
      entityType: null,
      entityId: null,
      isDeleted: true,
      deletedAt,
      deletedBy: 'user-9',
      uploadedBy: 'user-1',
      createdAt: new Date('2026-10-13T09:15:00.000Z'),
      updatedAt: new Date('2026-10-14T10:00:00.000Z'),
    };

    const dto = toFileUploadDto(row);

    expect(dto.status).toBe('CONFIRMED');
    expect(dto.expiresAt).toBeNull();
    expect(dto.confirmedAt).toBe(confirmedAt.toISOString());
    expect(dto.isDeleted).toBe(true);
    expect(dto.deletedAt).toBe(deletedAt.toISOString());
    expect(dto.deletedBy).toBe('user-9');
  });
});
