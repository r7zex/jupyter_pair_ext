const PREFIX_BYTES = 5;
export const MAX_WIRE_HEADER_BYTES = 1024 * 1024;
export const MAX_WIRE_FRAME_BYTES = 64 * 1024 * 1024 + MAX_WIRE_HEADER_BYTES + PREFIX_BYTES;
const FRAME_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

export interface WireFrame<T extends Record<string, unknown> = Record<string, unknown>> {
  type: string;
  meta: T;
  payload: Uint8Array;
}

export function encodeFrame(
  type: string,
  meta: Record<string, unknown> = {},
  payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
): Buffer {
  if (!FRAME_TYPE_PATTERN.test(type)) throw new Error('Invalid Pair Notebook frame type.');
  const header = Buffer.from(JSON.stringify({ type, meta }), 'utf8');
  if (header.byteLength > MAX_WIRE_HEADER_BYTES) throw new Error('Pair Notebook frame header is too large.');
  if (PREFIX_BYTES + header.byteLength + payload.byteLength > MAX_WIRE_FRAME_BYTES) {
    throw new Error('Pair Notebook frame exceeds the wire size limit.');
  }
  const frame = Buffer.allocUnsafe(PREFIX_BYTES + header.byteLength + payload.byteLength);
  frame.writeUInt8(1, 0);
  frame.writeUInt32BE(header.byteLength, 1);
  header.copy(frame, PREFIX_BYTES);
  Buffer.from(payload).copy(frame, PREFIX_BYTES + header.byteLength);
  return frame;
}

export function decodeFrame(input: Buffer | ArrayBuffer | Buffer[]): WireFrame {
  const inputLength = Array.isArray(input)
    ? input.reduce((total, part) => total + part.byteLength, 0)
    : input.byteLength;
  if (!Number.isSafeInteger(inputLength) || inputLength > MAX_WIRE_FRAME_BYTES) {
    throw new Error('Pair Notebook frame exceeds the wire size limit.');
  }
  const buffer = Array.isArray(input)
    ? Buffer.concat(input)
    : Buffer.isBuffer(input)
      ? input
      : Buffer.from(input);
  if (buffer.byteLength < PREFIX_BYTES || buffer.readUInt8(0) !== 1) {
    throw new Error('Unsupported Pair Notebook wire frame.');
  }
  const headerLength = buffer.readUInt32BE(1);
  if (headerLength > buffer.byteLength - PREFIX_BYTES || headerLength > MAX_WIRE_HEADER_BYTES) {
    throw new Error('Invalid Pair Notebook frame header length.');
  }
  const parsed = JSON.parse(buffer.subarray(PREFIX_BYTES, PREFIX_BYTES + headerLength).toString('utf8')) as {
    type?: unknown;
    meta?: unknown;
  };
  if (typeof parsed.type !== 'string' || !FRAME_TYPE_PATTERN.test(parsed.type)
    || typeof parsed.meta !== 'object' || parsed.meta === null || Array.isArray(parsed.meta)) {
    throw new Error('Invalid Pair Notebook frame header.');
  }
  return {
    type: parsed.type,
    meta: parsed.meta as Record<string, unknown>,
    payload: buffer.subarray(PREFIX_BYTES + headerLength),
  };
}
