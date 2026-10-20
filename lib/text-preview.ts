import fs from "fs";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";

export interface TextPreviewChunk {
  content: string;
  nextOffset: number;
  truncated: boolean;
  /**
   * The size the loaded content really reaches, which callers must show and
   * compare against instead of `fileSize` when the two disagree (see `atEof`).
   */
  size: number;
}

function utf8SequenceLength(byte: number): number {
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

export function readTextPreviewChunk(
  filePath: string,
  fileSize: number,
  offset: number,
): TextPreviewChunk {
  const length = Math.min(TEXT_PREVIEW_MAX_BYTES + 1, fileSize - offset);
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, "r");
  let bytesRead: number;
  try {
    bytesRead = fs.readSync(descriptor, buffer, 0, length, offset);
  } finally {
    fs.closeSync(descriptor);
  }

  // A short read is the end of the data, not a chunk boundary: the request was
  // already capped at `fileSize - offset`.
  //
  // It cannot be ignored, because a size can be a lie. A transparent encryption
  // filter driver (corporate DLP) hands `statSync` the *ciphertext* length while
  // decrypting reads, which stop at the plaintext end: a 12.6 KB Markdown file
  // then asks for 28.6 KB, gets 12.6 KB, and any consumer that trusts `fileSize`
  // alone calls the fully loaded file truncated. That removed the Markdown
  // Preview tab, since a truncated file is only partly loaded. Trust the read.
  const atEof = bytesRead < length;
  let end = Math.min(bytesRead, TEXT_PREVIEW_MAX_BYTES);
  if (!atEof && offset + end < fileSize) {
    let sequenceStart = end;
    while (sequenceStart > end - 3 && (buffer[sequenceStart] & 0xc0) === 0x80) {
      sequenceStart--;
    }
    if (utf8SequenceLength(buffer[sequenceStart]) > end - sequenceStart) {
      end = sequenceStart;
    }
  }
  const nextOffset = offset + end;

  return {
    content: buffer.toString("utf8", 0, end),
    nextOffset,
    truncated: !atEof && nextOffset < fileSize,
    size: atEof ? nextOffset : fileSize,
  };
}

/**
 * The number of bytes a read of `filePath` can actually return, which a
 * transparent encryption filter driver reports as smaller than its own
 * `statSync` size (see `readTextPreviewChunk`).
 *
 * Serving the metadata size would declare bytes the stream never produces: a
 * download then ends early under a `Content-Length` the reader is still waiting
 * on. Reads past the end return no data rather than throwing, so a probe finds
 * the real end. Returns `reportedSize` whenever the last byte is there, so an
 * ordinary file costs one extra 1-byte read.
 */
export function getReadableFileSize(filePath: string, reportedSize: number): number {
  if (reportedSize <= 0) return reportedSize;
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, "r");
  } catch {
    return reportedSize;
  }
  try {
    const probe = Buffer.alloc(1);
    // The driver adds ciphertext around the data, it does not hide its tail,
    // so a readable last byte means the reported length is the real one.
    if (fs.readSync(descriptor, probe, 0, 1, reportedSize - 1) === 1) return reportedSize;
    // Binary search the last byte that a read returns data for.
    let low = 0;
    let high = reportedSize - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fs.readSync(descriptor, probe, 0, 1, middle) === 1) low = middle;
      else high = middle - 1;
    }
    return fs.readSync(descriptor, probe, 0, 1, low) === 1 ? low + 1 : 0;
  } catch {
    return reportedSize;
  } finally {
    fs.closeSync(descriptor);
  }
}
