import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { $Enums, type FileUpload, type Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { AppError } from '../../common/errors/app-error.js';
import { FilesRepository } from './files.repository.js';
import { MinioService } from './minio.service.js';
import {
  MAX_FILE_SIZE_BYTES,
  MAX_LIST_LIMIT,
  MIME_WHITELIST,
  PRESIGN_EXPIRY_SECONDS,
  UPLOAD_PENDING_TTL_MS,
} from './files.constants.js';
import { sanitizeFilename } from './utils/sanitize-filename.js';
import {
  toFileUploadDto,
  type FileUploadDto,
  type FileUploadListDto,
} from './utils/file-upload.mapper.js';
import type { ListFilesQueryDto } from './dto/list-files-query.dto.js';
import type { UploadFileDto } from './dto/upload-file.dto.js';
import type { ConfirmFilesDto } from './dto/confirm-files.dto.js';
import type { ReconcileFilesDto } from './dto/reconcile-files.dto.js';

export interface FileReconcileResultDto {
  confirmed: FileUploadDto[];
  softDeleted: number;
}

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly filesRepository: FilesRepository,
    private readonly minioService: MinioService,
  ) {}

  ensureOwnershipOrAdmin(file: FileUpload, user: AuthUser): void {
    if (file.uploadedBy !== user.id && user.role !== $Enums.RoleName.ADMIN) {
      throw new AppError(
        HttpStatus.NOT_FOUND,
        'FILE_NOT_FOUND',
        'File not found',
      );
    }
  }

  async upload(
    file: UploadedFile | undefined,
    user: AuthUser,
    metadata: UploadFileDto = {},
  ): Promise<FileUploadDto> {
    if (!file) {
      throw new AppError(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'File is required',
      );
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      throw new AppError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'FILE_TOO_LARGE',
        'File exceeds the 25 MB limit',
      );
    }
    const allowedMimeType = this.getWhitelistedMimeType(file.originalname);
    if (allowedMimeType !== file.mimetype) {
      throw new AppError(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'UNSUPPORTED_MEDIA_TYPE',
        `MIME type ${file.mimetype} is not allowed`,
      );
    }

    const checksum = createHash('sha256').update(file.buffer).digest('hex');
    const objectKey = `${user.id}/${randomUUID()}-${sanitizeFilename(file.originalname)}`;

    try {
      await this.minioService.putObject(
        objectKey,
        file.buffer,
        file.size,
        file.mimetype,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`MinIO putObject failed for ${objectKey}: ${reason}`);
      throw new AppError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'MINIO_UNAVAILABLE',
        'Object storage is temporarily unavailable',
      );
    }

    try {
      const now = Date.now();
      const created = await this.filesRepository.create({
        bucket: this.minioService.bucketName,
        objectKey,
        originalName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        checksum,
        status: 'PENDING',
        expiresAt: new Date(now + UPLOAD_PENDING_TTL_MS),
        entityType: metadata.entityType ?? null,
        entityId: metadata.entityId ?? null,
        uploadedBy: user.id,
      });
      return toFileUploadDto(created);
    } catch (error) {
      await this.compensateRemoveObject(objectKey);
      throw error;
    }
  }

  async list(
    query: ListFilesQueryDto,
    user: AuthUser,
  ): Promise<FileUploadListDto> {
    const page = query.page;
    const limit = Math.min(query.limit, MAX_LIST_LIMIT);
    const where: Prisma.FileUploadWhereInput = {
      isDeleted: false,
    };
    if (user.role !== $Enums.RoleName.ADMIN) {
      where.uploadedBy = user.id;
    }
    if (query.search) {
      where.originalName = {
        contains: query.search,
        mode: 'insensitive',
      };
    }
    const orderBy = this.parseSort(query.sort);
    const [files, total] = await Promise.all([
      this.filesRepository.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.filesRepository.count(where),
    ]);
    return {
      items: files.map(toFileUploadDto),
      total,
      page,
      limit,
    };
  }

  async getById(id: string, user: AuthUser): Promise<FileUploadDto> {
    const file = await this.getAccessibleActiveFile(id, user);
    return toFileUploadDto(file);
  }

  async getPresignedUrl(
    id: string,
    user: AuthUser,
  ): Promise<{ url: string; expiresAt: Date }> {
    const file = await this.getAccessibleActiveFile(id, user);
    const issuedAt = Date.now();
    try {
      const url = await this.minioService.presignedGetObject(
        file.objectKey,
        PRESIGN_EXPIRY_SECONDS,
        file.bucket,
      );
      return {
        url,
        expiresAt: new Date(issuedAt + PRESIGN_EXPIRY_SECONDS * 1000),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`MinIO presignedGetObject failed: ${reason}`);
      throw new AppError(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'MINIO_UNAVAILABLE',
        'Object storage is temporarily unavailable',
      );
    }
  }

  async remove(id: string, user: AuthUser): Promise<FileUploadDto> {
    await this.getAccessibleActiveFile(id, user);
    const deletedCount = await this.filesRepository.softDelete(id, user.id);
    if (deletedCount === 0) {
      throw new AppError(
        HttpStatus.NOT_FOUND,
        'FILE_NOT_FOUND',
        'File not found',
      );
    }
    const updated = await this.filesRepository.findById(id);
    if (!updated) {
      throw new AppError(
        HttpStatus.NOT_FOUND,
        'FILE_NOT_FOUND',
        'File not found',
      );
    }
    return toFileUploadDto(updated);
  }

  async confirm(
    dto: ConfirmFilesDto,
    user: AuthUser,
  ): Promise<FileUploadDto[]> {
    const ids = [...new Set(dto.fileIds)];
    const files = await this.filesRepository.findManyByIds(ids);
    if (files.length !== ids.length) {
      throw new AppError(
        HttpStatus.NOT_FOUND,
        'FILE_NOT_FOUND',
        'File not found',
      );
    }
    for (const file of files) {
      this.ensureOwnershipOrAdmin(file, user);
    }
    const confirmedAt = new Date();
    const confirmed = await this.filesRepository.confirmMany({
      ids,
      confirmedAt,
      entityType: dto.entityType,
      entityId: dto.entityId,
    });
    return confirmed.map(toFileUploadDto);
  }

  async reconcile(
    dto: ReconcileFilesDto,
    user: AuthUser,
  ): Promise<FileReconcileResultDto> {
    const ids = [...new Set(dto.activeFileIds)];
    const files = await this.filesRepository.findManyByIds(ids);
    if (files.length !== ids.length) {
      throw new AppError(
        HttpStatus.NOT_FOUND,
        'FILE_NOT_FOUND',
        'File not found',
      );
    }
    for (const file of files) {
      this.ensureOwnershipOrAdmin(file, user);
    }
    const confirmed = await this.filesRepository.confirmMany({
      ids,
      confirmedAt: new Date(),
      entityType: dto.entityType,
      entityId: dto.entityId,
    });
    const softDeleted = await this.filesRepository.softDeleteByEntityExcept({
      entityType: dto.entityType,
      entityId: dto.entityId,
      exceptIds: ids,
      deletedBy: user.id,
      uploadedBy: user.role === $Enums.RoleName.ADMIN ? undefined : user.id,
    });
    return {
      confirmed: confirmed.map(toFileUploadDto),
      softDeleted,
    };
  }

  private async getAccessibleActiveFile(
    id: string,
    user: AuthUser,
  ): Promise<FileUpload> {
    const file = await this.filesRepository.findById(id);
    if (!file || file.isDeleted) {
      throw new AppError(
        HttpStatus.NOT_FOUND,
        'FILE_NOT_FOUND',
        'File not found',
      );
    }
    this.ensureOwnershipOrAdmin(file, user);
    return file;
  }

  private async compensateRemoveObject(objectKey: string): Promise<void> {
    try {
      await this.minioService.removeObject(objectKey);
    } catch (compensationError) {
      const reason =
        compensationError instanceof Error
          ? compensationError.message
          : String(compensationError);
      this.logger.error(
        `Compensating removeObject failed for ${objectKey}: ${reason}`,
      );
    }
  }

  private parseSort(
    sort: string | undefined,
  ): Prisma.FileUploadOrderByWithRelationInput {
    if (sort === undefined) {
      return { createdAt: 'desc' };
    }
    const parts = sort.split(':');
    if (parts.length !== 2 || (parts[1] !== 'asc' && parts[1] !== 'desc')) {
      throw this.invalidSortError();
    }
    switch (parts[0]) {
      case 'createdAt':
        return { createdAt: parts[1] };
      case 'originalName':
        return { originalName: parts[1] };
      case 'size':
        return { sizeBytes: parts[1] };
      default:
        throw this.invalidSortError();
    }
  }

  private invalidSortError(): AppError {
    return new AppError(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
      'Invalid sort parameter',
      ['sort must be <createdAt|originalName|size>:<asc|desc>'],
    );
  }

  private getWhitelistedMimeType(originalName: string): string | undefined {
    const dotIndex = originalName.lastIndexOf('.');
    if (dotIndex < 0 || dotIndex === originalName.length - 1) {
      return undefined;
    }
    const extension = originalName.slice(dotIndex + 1).toLowerCase();
    return MIME_WHITELIST[extension];
  }
}
