export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

export const MAX_LIST_LIMIT = 100;

export const PRESIGN_EXPIRY_SECONDS = 900;

export const UPLOAD_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export const PURGE_BATCH_SIZE = 100;

export const MIME_WHITELIST: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
};
