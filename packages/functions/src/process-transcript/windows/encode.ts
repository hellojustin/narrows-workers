/**
 * windows.bin encoder and decoder. Format: docs/windows-format.md.
 *
 * Layout (little-endian):
 *   0   4  ASCII "PWIN"
 *   4   2  uint16 formatVersion
 *   6   2  uint16 reserved = 0
 *   8   4  uint32 headerLength H
 *   12  H  UTF-8 JSON header
 *   then zero padding to a multiple of 8
 *   tableOffset  N x 32  sentence table: sentStart, sentEnd, win10End, win30End (float64)
 *   rowsOffset   N x rowBytes  vector rows: one float16 vector per window length
 */

import { fromFloat16Bits, toFloat16Bits } from './float16';

export const WINDOWS_MAGIC = 'PWIN';
export const WINDOWS_FORMAT_VERSION = 1;
const PREAMBLE_BYTES = 12;
const TABLE_ROW_BYTES = 32;

export interface WindowsHeader {
  formatVersion: number;
  embeddingModel: string;
  embeddingDim: number;
  dtype: 'float16';
  sentenceCount: number;
  windowSecs: number[];
  stepSentences: number;
  tableOffset: number;
  rowsOffset: number;
  rowBytes: number;
  transcriptSha256: string;
  generatedAt: string;
}

/** One sentence table row. `windowEnds` has one entry per window length. */
export interface WindowsTableRow {
  sentStart: number;
  sentEnd: number;
  windowEnds: number[];
}

export interface WindowsFileSpec {
  embeddingModel: string;
  embeddingDim: number;
  windowSecs: number[];
  transcriptSha256: string;
  generatedAt: string;
  table: WindowsTableRow[];
}

/** A file whose header and table are written and whose vector rows are zero. */
export interface WindowsFileBuffer {
  header: WindowsHeader;
  buffer: Buffer;
}

function align8(n: number): number {
  return Math.ceil(n / 8) * 8;
}

/**
 * Build the header. Its JSON contains its own offsets, so its length depends on
 * them; repeat until the length stops changing.
 */
function buildHeader(spec: WindowsFileSpec): { header: WindowsHeader; json: Buffer } {
  const n = spec.table.length;
  const rowBytes = spec.windowSecs.length * spec.embeddingDim * 2;
  let tableOffset = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    const header: WindowsHeader = {
      formatVersion: WINDOWS_FORMAT_VERSION,
      embeddingModel: spec.embeddingModel,
      embeddingDim: spec.embeddingDim,
      dtype: 'float16',
      sentenceCount: n,
      windowSecs: spec.windowSecs,
      stepSentences: 1,
      tableOffset,
      rowsOffset: tableOffset + n * TABLE_ROW_BYTES,
      rowBytes,
      transcriptSha256: spec.transcriptSha256,
      generatedAt: spec.generatedAt,
    };
    const json = Buffer.from(JSON.stringify(header), 'utf8');
    const next = align8(PREAMBLE_BYTES + json.length);
    if (next === tableOffset) return { header, json };
    tableOffset = next;
  }
  throw new Error('windows.bin header offsets did not settle');
}

/** Allocate a file with the header and sentence table written. */
export function createWindowsFile(spec: WindowsFileSpec): WindowsFileBuffer {
  for (const row of spec.table) {
    if (row.windowEnds.length !== spec.windowSecs.length) {
      throw new Error('every table row needs one window end per window length');
    }
  }

  const { header, json } = buildHeader(spec);
  const total = header.rowsOffset + header.sentenceCount * header.rowBytes;
  const buffer = Buffer.alloc(total);

  buffer.write(WINDOWS_MAGIC, 0, 'ascii');
  buffer.writeUInt16LE(WINDOWS_FORMAT_VERSION, 4);
  buffer.writeUInt16LE(0, 6);
  buffer.writeUInt32LE(json.length, 8);
  json.copy(buffer, PREAMBLE_BYTES);

  spec.table.forEach((row, i) => {
    const at = header.tableOffset + i * TABLE_ROW_BYTES;
    buffer.writeDoubleLE(row.sentStart, at);
    buffer.writeDoubleLE(row.sentEnd, at + 8);
    // v1 stores exactly two window ends (10s and 30s).
    buffer.writeDoubleLE(row.windowEnds[0] ?? row.sentEnd, at + 16);
    buffer.writeDoubleLE(row.windowEnds[1] ?? row.sentEnd, at + 24);
  });

  return { header, buffer };
}

/** Write one window's vector as float16 into its row. */
export function writeVector(
  file: WindowsFileBuffer,
  row: number,
  windowIndex: number,
  vector: ArrayLike<number>
): void {
  const { header, buffer } = file;
  if (vector.length !== header.embeddingDim) {
    throw new Error(`expected ${header.embeddingDim} values, got ${vector.length}`);
  }
  let at = header.rowsOffset + row * header.rowBytes + windowIndex * header.embeddingDim * 2;
  for (let k = 0; k < vector.length; k++) {
    buffer.writeUInt16LE(toFloat16Bits(vector[k]), at);
    at += 2;
  }
}

export interface DecodedWindowsFile {
  header: WindowsHeader;
  table: WindowsTableRow[];
  /** vectors[windowIndex][row] is a list of embeddingDim numbers. */
  vectors: number[][][];
}

/** Parse a complete windows.bin. Used by tests and the fixture script. */
export function decodeWindowsFile(buffer: Buffer): DecodedWindowsFile {
  if (buffer.toString('ascii', 0, 4) !== WINDOWS_MAGIC) {
    throw new Error('not a windows.bin file');
  }
  const version = buffer.readUInt16LE(4);
  if (version !== WINDOWS_FORMAT_VERSION) {
    throw new Error(`unsupported windows.bin version ${version}`);
  }
  const headerLength = buffer.readUInt32LE(8);
  const header = JSON.parse(
    buffer.toString('utf8', PREAMBLE_BYTES, PREAMBLE_BYTES + headerLength)
  ) as WindowsHeader;

  const table: WindowsTableRow[] = [];
  for (let i = 0; i < header.sentenceCount; i++) {
    const at = header.tableOffset + i * TABLE_ROW_BYTES;
    table.push({
      sentStart: buffer.readDoubleLE(at),
      sentEnd: buffer.readDoubleLE(at + 8),
      windowEnds: [buffer.readDoubleLE(at + 16), buffer.readDoubleLE(at + 24)],
    });
  }

  const vectors: number[][][] = header.windowSecs.map(() => []);
  for (let i = 0; i < header.sentenceCount; i++) {
    for (let w = 0; w < header.windowSecs.length; w++) {
      const at = header.rowsOffset + i * header.rowBytes + w * header.embeddingDim * 2;
      const vec: number[] = [];
      for (let k = 0; k < header.embeddingDim; k++) {
        vec.push(fromFloat16Bits(buffer.readUInt16LE(at + k * 2)));
      }
      vectors[w].push(vec);
    }
  }

  return { header, table, vectors };
}
