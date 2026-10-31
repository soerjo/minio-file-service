import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';

interface MinioCredentials {
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
}

@Injectable()
export class MinioService implements OnModuleInit {
  private readonly logger = new Logger(MinioService.name);
  private readonly credentials: MinioCredentials;
  private readonly internalEndpoint: string;
  private readonly internalPort: number;
  private readonly publicEndpoint: string;
  private readonly publicPort: number;
  private readonly client: Minio.Client;
  private readonly bucket: string;
  private publicClient?: Minio.Client;

  constructor(private readonly configService: ConfigService) {
    this.internalEndpoint = this.configService.get<string>('MINIO_ENDPOINT')!;
    this.internalPort = Number(this.configService.get<string>('MINIO_PORT')!);
    this.credentials = {
      useSSL: this.configService.get<string>('MINIO_USE_SSL') === 'true',
      accessKey: this.configService.get<string>('MINIO_ACCESS_KEY')!,
      secretKey: this.configService.get<string>('MINIO_SECRET_KEY')!,
    };
    // Presigned URLs must be signed with the host the client/browser can reach
    // (SigV4 covers the Host header), so fall back to the internal endpoint
    // when no separate public endpoint is configured.
    this.publicEndpoint =
      this.configService.get<string>('MINIO_PUBLIC_ENDPOINT') ||
      this.internalEndpoint;
    const publicPort = this.configService.get<string>('MINIO_PUBLIC_PORT');
    this.publicPort = publicPort ? Number(publicPort) : this.internalPort;
    this.client = this.createClient(this.internalEndpoint, this.internalPort);
    this.bucket = this.configService.get<string>('MINIO_BUCKET')!;
  }

  get bucketName(): string {
    return this.bucket;
  }

  private createClient(endPoint: string, port: number): Minio.Client {
    return new Minio.Client({
      endPoint,
      port,
      useSSL: this.credentials.useSSL,
      accessKey: this.credentials.accessKey,
      secretKey: this.credentials.secretKey,
    });
  }

  /**
   * Lazily builds the client used to sign presigned URLs. When the public
   * endpoint matches the internal one, the internal client is reused so no
   * extra connection pool is created.
   */
  private getSigningClient(): Minio.Client {
    if (this.publicClient) {
      return this.publicClient;
    }
    if (
      this.publicEndpoint === this.internalEndpoint &&
      this.publicPort === this.internalPort
    ) {
      this.publicClient = this.client;
      return this.publicClient;
    }
    this.publicClient = this.createClient(this.publicEndpoint, this.publicPort);
    this.logger.log(
      `MinIO presigned URLs will be signed for ${this.publicEndpoint}:${this.publicPort}`,
    );
    return this.publicClient;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    const exists = await this.client.bucketExists(this.bucket);
    if (exists) {
      this.logger.log(`MinIO bucket "${this.bucket}" is available`);
      return;
    }
    await this.client.makeBucket(this.bucket);
    this.logger.log(`MinIO bucket "${this.bucket}" created`);
  }

  async putObject(
    objectKey: string,
    body: Buffer,
    size: number,
    contentType: string,
  ): Promise<void> {
    await this.client.putObject(this.bucket, objectKey, body, size, {
      'Content-Type': contentType,
    });
  }

  async presignedGetObject(
    objectKey: string,
    expirySeconds: number,
    bucket: string = this.bucket,
  ): Promise<string> {
    return this.getSigningClient().presignedGetObject(
      bucket,
      objectKey,
      expirySeconds,
    );
  }

  async removeObject(
    objectKey: string,
    bucket: string = this.bucket,
  ): Promise<void> {
    await this.client.removeObject(bucket, objectKey);
  }
}
