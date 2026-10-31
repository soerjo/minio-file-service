import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';

export class ReconcileFilesDto {
  @ApiProperty({ example: 'invoice' })
  @IsString()
  entityType!: string;

  @ApiProperty({ example: 'invoice-123' })
  @IsString()
  entityId!: string;

  @ApiProperty({
    example: ['file-1', 'file-2'],
    description:
      'Current active file ids for the entity. An empty array deletes previously tagged files for the entity.',
  })
  @IsArray()
  @IsString({ each: true })
  activeFileIds!: string[];
}
