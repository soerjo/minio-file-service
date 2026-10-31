import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsOptional, IsString } from 'class-validator';

export class ConfirmFilesDto {
  @ApiProperty({
    example: ['file-1', 'file-2'],
    description:
      'File ids to confirm. Each file must be owned by the current user unless the current user is ADMIN.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  fileIds!: string[];

  @ApiPropertyOptional({
    example: 'invoice',
    description: 'Optional entity type to assign during confirmation.',
  })
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiPropertyOptional({
    example: 'invoice-123',
    description: 'Optional entity id to assign during confirmation.',
  })
  @IsOptional()
  @IsString()
  entityId?: string;
}
