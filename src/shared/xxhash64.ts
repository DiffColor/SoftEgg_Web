const PRIME1 = 11400714785074694791n;
const PRIME2 = 14029467366897019727n;
const PRIME3 = 1609587929392839161n;
const PRIME4 = 9650029242287828579n;
const PRIME5 = 2870177450012600261n;
const MASK_64 = 0xffffffffffffffffn;

export async function computeXxHash64(
  bytes: Uint8Array,
  onProgress?: (progress: number, processedBytes: number, totalBytes: number) => void,
  shouldCancel?: () => boolean,
): Promise<string> {
  const totalBytes = bytes.byteLength;
  const tail = new Uint8Array(32);
  let tailLength = 0;
  let hadStripe = false;
  let totalLength = 0n;
  let processedBytes = 0;
  let lastReportedBytes = -1;
  let v1 = toUint64(PRIME1 + PRIME2);
  let v2 = toUint64(PRIME2);
  let v3 = 0n;
  let v4 = toUint64(-PRIME1);

  for (let start = 0; start < bytes.length; start += 256 * 1024) {
    if (shouldCancel?.()) {
      throw new Error("작업이 중단되었습니다.");
    }
    const chunk = bytes.subarray(start, Math.min(start + 256 * 1024, bytes.length));
    totalLength += BigInt(chunk.length);
    processedBytes += chunk.length;
    let offset = 0;

    if (tailLength > 0) {
      const needed = 32 - tailLength;
      if (chunk.length < needed) {
        tail.set(chunk, tailLength);
        tailLength += chunk.length;
        continue;
      }

      tail.set(chunk.subarray(0, needed), tailLength);
      v1 = round(v1, readUint64LE(tail, 0));
      v2 = round(v2, readUint64LE(tail, 8));
      v3 = round(v3, readUint64LE(tail, 16));
      v4 = round(v4, readUint64LE(tail, 24));
      hadStripe = true;
      offset += needed;
      tailLength = 0;
    }

    const limit = chunk.length - ((chunk.length - offset) % 32);
    while (offset < limit) {
      v1 = round(v1, readUint64LE(chunk, offset));
      v2 = round(v2, readUint64LE(chunk, offset + 8));
      v3 = round(v3, readUint64LE(chunk, offset + 16));
      v4 = round(v4, readUint64LE(chunk, offset + 24));
      hadStripe = true;
      offset += 32;
    }

    if (offset < chunk.length) {
      tailLength = chunk.length - offset;
      tail.set(chunk.subarray(offset), 0);
    }

    if (onProgress && totalBytes > 0) {
      const shouldReport =
        processedBytes === totalBytes || processedBytes - lastReportedBytes >= 256 * 1024;
      if (shouldReport) {
        lastReportedBytes = processedBytes;
        onProgress((processedBytes / totalBytes) * 100, processedBytes, totalBytes);
      }
      await Promise.resolve();
    }
  }

  let hash: bigint;
  if (hadStripe) {
    hash = toUint64(rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18));
    hash = mergeRound(hash, v1);
    hash = mergeRound(hash, v2);
    hash = mergeRound(hash, v3);
    hash = mergeRound(hash, v4);
  } else {
    hash = toUint64(PRIME5);
  }

  hash = toUint64(hash + totalLength);

  let tailOffset = 0;
  while (tailOffset + 8 <= tailLength) {
    const lane = readUint64LE(tail, tailOffset);
    hash ^= round(0n, lane);
    hash = toUint64(rotl(hash, 27) * PRIME1 + PRIME4);
    tailOffset += 8;
  }

  if (tailOffset + 4 <= tailLength) {
    const lane = readUint32LE(tail, tailOffset);
    hash ^= toUint64(lane * PRIME1);
    hash = toUint64(rotl(hash, 23) * PRIME2 + PRIME3);
    tailOffset += 4;
  }

  while (tailOffset < tailLength) {
    hash ^= toUint64(BigInt(tail[tailOffset]) * PRIME5);
    hash = toUint64(rotl(hash, 11) * PRIME1);
    tailOffset += 1;
  }

  return avalanche(hash).toString(16).padStart(16, "0");
}

function round(acc: bigint, input: bigint): bigint {
  let next = toUint64(acc + toUint64(input * PRIME2));
  next = rotl(next, 31);
  next = toUint64(next * PRIME1);
  return next;
}

function mergeRound(acc: bigint, value: bigint): bigint {
  let next = acc ^ round(0n, value);
  next = toUint64(toUint64(next * PRIME1) + PRIME4);
  return next;
}

function avalanche(hash: bigint): bigint {
  let next = hash;
  next ^= next >> 33n;
  next = toUint64(next * PRIME2);
  next ^= next >> 29n;
  next = toUint64(next * PRIME3);
  next ^= next >> 32n;
  return toUint64(next);
}

function rotl(value: bigint, count: number): bigint {
  return toUint64((value << BigInt(count)) | (value >> BigInt(64 - count)));
}

function readUint64LE(bytes: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let index = 0; index < 8; index += 1) {
    result |= BigInt(bytes[offset + index] ?? 0) << BigInt(index * 8);
  }
  return toUint64(result);
}

function readUint32LE(bytes: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let index = 0; index < 4; index += 1) {
    result |= BigInt(bytes[offset + index] ?? 0) << BigInt(index * 8);
  }
  return toUint64(result);
}

function toUint64(value: bigint): bigint {
  return value & MASK_64;
}
