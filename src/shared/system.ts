import { randomBytes } from 'node:crypto';
import type { Clock, IdGenerator } from '@/application/ports/services';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** RFC 9562 UUID v7: 48-bit unix-ms timestamp + random bits, so ids sort by creation time. */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ts = BigInt(nowMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class UuidV7Generator implements IdGenerator {
  next(): string {
    return uuidv7();
  }
}
