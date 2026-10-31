import { plainToInstance } from 'class-transformer';
import { validateCronExpression } from 'cron';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPort,
  IsString,
  Min,
  validateSync,
} from 'class-validator';

enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @IsPort()
  @IsOptional()
  PORT: string = '3000';

  @IsString()
  @IsNotEmpty()
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty()
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @IsNotEmpty()
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @IsOptional()
  JWT_ACCESS_EXPIRATION: string = '15m';

  @IsString()
  @IsOptional()
  JWT_REFRESH_EXPIRATION: string = '7d';

  @IsString()
  @IsOptional()
  MINIO_ENDPOINT: string = 'localhost';

  @IsPort()
  @IsOptional()
  MINIO_PORT: string = '9000';

  // Public endpoint used ONLY to sign presigned download URLs so they are
  // reachable from a browser. Falls back to MINIO_ENDPOINT/MINIO_PORT when
  // unset (see MinioService).
  @IsString()
  @IsOptional()
  MINIO_PUBLIC_ENDPOINT?: string;

  @IsPort()
  @IsOptional()
  MINIO_PUBLIC_PORT?: string;

  @IsIn(['true', 'false'])
  @IsOptional()
  MINIO_USE_SSL: string = 'false';

  @IsString()
  @IsNotEmpty()
  MINIO_ACCESS_KEY!: string;

  @IsString()
  @IsNotEmpty()
  MINIO_SECRET_KEY!: string;

  @IsString()
  @IsOptional()
  MINIO_BUCKET: string = 'app-uploads';

  // Hard-delete (purge) job. Disabled by default so no object is ever removed
  // from storage unless explicitly opted in.
  @IsBoolean()
  @IsOptional()
  HARD_DELETE_ENABLED: boolean = false;

  @IsInt()
  @Min(1)
  @IsOptional()
  HARD_DELETE_RETENTION_DAYS: number = 365;

  @IsInt()
  @Min(1)
  @IsOptional()
  PENDING_FILE_TTL_HOURS: number = 24;

  @IsString()
  @IsNotEmpty()
  @IsOptional()
  PENDING_FILE_CLEANUP_CRON: string = '0 0 * * *';
}

export function validate(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });

  const cronValidation = validateCronExpression(
    validated.PENDING_FILE_CLEANUP_CRON,
  );
  if (!cronValidation.valid) {
    throw new Error(
      `PENDING_FILE_CLEANUP_CRON must be a valid cron expression: ${cronValidation.error?.message ?? 'invalid cron expression'}`,
    );
  }

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }
  return validated;
}
