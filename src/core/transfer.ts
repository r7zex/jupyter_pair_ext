export const DEFAULT_TRANSFER_CHUNK_SIZE = 64 * 1024;
export const MAX_TRANSFER_CHUNK_SIZE = 1024 * 1024;
export const MAX_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface IncomingTransferShape {
  size: number;
  chunkSize: number;
  expectedChunks: number;
  hash: string;
}

export function validateIncomingTransfer(
  meta: Record<string, unknown>,
  defaultChunkSize = DEFAULT_TRANSFER_CHUNK_SIZE,
): IncomingTransferShape {
  const size = Number(meta.size);
  const chunkSize = Number(meta.chunkSize ?? defaultChunkSize);
  const expectedChunks = Number(meta.chunks);
  const hash = String(meta.hash ?? '').toLowerCase();

  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TRANSFER_BYTES) {
    throw new Error(`Transfer size must be an integer between 0 and ${MAX_TRANSFER_BYTES} bytes.`);
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_TRANSFER_CHUNK_SIZE) {
    throw new Error(`Transfer chunk size must be an integer between 1 and ${MAX_TRANSFER_CHUNK_SIZE} bytes.`);
  }
  const requiredChunks = Math.max(1, Math.ceil(size / chunkSize));
  if (!Number.isSafeInteger(expectedChunks) || expectedChunks !== requiredChunks) {
    throw new Error(`Transfer chunk count must equal ${requiredChunks} for the declared size.`);
  }
  if (!SHA256_PATTERN.test(hash)) {
    throw new Error('Transfer hash must be a hexadecimal SHA-256 digest.');
  }
  return { size, chunkSize, expectedChunks, hash };
}

export function expectedTransferChunkBytes(shape: IncomingTransferShape, index: number): number {
  if (!Number.isSafeInteger(index) || index < 0 || index >= shape.expectedChunks) return -1;
  if (index < shape.expectedChunks - 1) return shape.chunkSize;
  return shape.size - (shape.chunkSize * index);
}
