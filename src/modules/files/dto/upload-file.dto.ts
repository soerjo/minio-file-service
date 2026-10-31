import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UploadFileDto {
  @ApiPropertyOptional({
    example: 'invoice',
    description: 'Optional entity type to tag the uploaded file with.',
  })
  @IsOptional()
  @IsString()
  entityType?: string;

  @ApiPropertyOptional({
    example: 'invoice-123',
    description: 'Optional entity id to tag the uploaded file with.',
  })
  @IsOptional()
  @IsString()
  entityId?: string;
}
