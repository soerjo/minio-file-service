import { Injectable } from '@nestjs/common';
import type { FileUpload, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';

@Injectable()
export class FilesRepository {
  constructor(private prisma: PrismaService) {}

  async create(
    data: Prisma.XOR<
      Prisma.FileUploadCreateInput,
      Prisma.FileUploadUncheckedCreateInput
    >,
  ): Promise<FileUpload> {
    return this.prisma.fileUpload.create({ data });
  }

  async findById(id: string): Promise<FileUpload | null> {
    return this.prisma.fileUpload.findUnique({ where: { id } });
  }

  async findManyByIds(ids: string[]): Promise<FileUpload[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.prisma.fileUpload.findMany({
      where: { id: { in: ids }, isDeleted: false },
    });
  }

  async findMany(params: {
    where: Prisma.FileUploadWhereInput;
    orderBy: Prisma.FileUploadOrderByWithRelationInput;
    skip: number;
    take: number;
  }): Promise<FileUpload[]> {
    return this.prisma.fileUpload.findMany({
      where: params.where,
      orderBy: params.orderBy,
      skip: params.skip,
      take: params.take,
    });
  }

  async count(where: Prisma.FileUploadWhereInput): Promise<number> {
    return this.prisma.fileUpload.count({ where });
  }

  async confirmMany(params: {
    ids: string[];
    confirmedAt: Date;
    entityType?: string;
    entityId?: string;
  }): Promise<FileUpload[]> {
    if (params.ids.length === 0) {
      return [];
    }
    const data: Prisma.FileUploadUpdateManyMutationInput = {
      status: 'CONFIRMED',
      expiresAt: null,
      confirmedAt: params.confirmedAt,
    };
    if (params.entityType !== undefined) {
      data.entityType = params.entityType;
    }
    if (params.entityId !== undefined) {
      data.entityId = params.entityId;
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.fileUpload.updateMany({
        where: { id: { in: params.ids }, isDeleted: false },
        data,
      });
      return tx.fileUpload.findMany({ where: { id: { in: params.ids } } });
    });
  }

  async softDelete(id: string, userId: string): Promise<number> {
    const result = await this.prisma.fileUpload.updateMany({
      where: { id, isDeleted: false },
      data: { isDeleted: true, deletedAt: new Date(), deletedBy: userId },
    });
    return result.count;
  }

  async softDeleteByEntityExcept(params: {
    entityType: string;
    entityId: string;
    exceptIds: string[];
    deletedBy: string;
    uploadedBy?: string;
  }): Promise<number> {
    const where: Prisma.FileUploadWhereInput = {
      entityType: params.entityType,
      entityId: params.entityId,
      isDeleted: false,
    };
    if (params.exceptIds.length > 0) {
      where.id = { notIn: params.exceptIds };
    }
    if (params.uploadedBy !== undefined) {
      where.uploadedBy = params.uploadedBy;
    }
    const result = await this.prisma.fileUpload.updateMany({
      where,
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy: params.deletedBy,
      },
    });
    return result.count;
  }

  async findExpiredPending(now: Date, take: number): Promise<FileUpload[]> {
    return this.prisma.fileUpload.findMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: now },
        isDeleted: false,
      },
      orderBy: { expiresAt: 'asc' },
      take,
    });
  }

  async hardDelete(id: string): Promise<void> {
    await this.prisma.fileUpload.delete({ where: { id } });
  }
}
