const STOP = 0
const TRUE = 1
const FALSE = 2
const BYTE = 3
const I16 = 4
const I32 = 5
const I64 = 6
const DOUBLE = 7
const BINARY = 8
const LIST = 9
const STRUCT = 12

export interface CompactThriftField {
  readonly type: number
  readonly value?: boolean | number | bigint
}

export interface CompactThriftPreflightOptions {
  readonly maxDepth: number
  readonly maxCollectionLength: number
  readonly maxTotalCollectionElements: number
  readonly maxBinaryLength: number
  readonly maxTotalFields: number
  readonly maxTotalStructs: number
  readonly captureFields?: boolean
}

export interface CompactThriftPreflightResult {
  readonly byteLength: number
  readonly fields: ReadonlyMap<string, Readonly<CompactThriftField>>
}

interface Reader {
  readonly input: Uint8Array
  readonly options: CompactThriftPreflightOptions
  readonly fields: Map<string, Readonly<CompactThriftField>>
  offset: number
  totalCollectionElements: number
  totalFields: number
  totalStructs: number
}

export function preflightCompactThrift(
  input: Uint8Array,
  options: CompactThriftPreflightOptions,
): CompactThriftPreflightResult {
  const reader: Reader = {
    input,
    options,
    fields: new Map(),
    offset: 0,
    totalCollectionElements: 0,
    totalFields: 0,
    totalStructs: 0,
  }
  scanStruct(reader, 0, '')
  return Object.freeze({ byteLength: reader.offset, fields: reader.fields })
}

function scanStruct(reader: Reader, depth: number, path: string): void {
  if (depth > reader.options.maxDepth) throw new Error('Compact Thrift nesting is too deep')
  reader.totalStructs += 1
  if (reader.totalStructs > reader.options.maxTotalStructs) {
    throw new Error('Compact Thrift struct count exceeds its budget')
  }
  let previousFieldId = 0

  while (true) {
    const header = readByte(reader)
    const type = header & 0x0f
    if (type === STOP) return
    const delta = header >>> 4
    const fieldId = delta === 0 ? readZigZagNumber(reader, 3) : previousFieldId + delta
    if (fieldId <= previousFieldId) {
      throw new Error('Compact Thrift fields are not strictly ordered')
    }
    reader.totalFields += 1
    if (reader.totalFields > reader.options.maxTotalFields) {
      throw new Error('Compact Thrift field count exceeds its budget')
    }
    previousFieldId = fieldId
    const fieldPath = path.length === 0 ? `${fieldId}` : `${path}.${fieldId}`
    const value = scanElement(reader, type, depth, fieldPath)
    if (reader.options.captureFields) {
      if (reader.fields.has(fieldPath)) throw new Error('Compact Thrift field is duplicated')
      reader.fields.set(fieldPath, Object.freeze(value === undefined ? { type } : { type, value }))
    }
  }
}

function scanElement(
  reader: Reader,
  type: number,
  depth: number,
  path: string,
): boolean | number | bigint | undefined {
  if (depth > reader.options.maxDepth) throw new Error('Compact Thrift nesting is too deep')
  switch (type) {
    case TRUE:
      return true
    case FALSE:
      return false
    case BYTE:
      return readByte(reader)
    case I16:
    case I32:
      return readZigZagNumber(reader, 5)
    case I64:
      return readZigZagBigInt(reader)
    case DOUBLE:
      requireBytes(reader, 8)
      reader.offset += 8
      return undefined
    case BINARY: {
      const length = readUnsignedNumber(reader, 5)
      if (length > reader.options.maxBinaryLength) {
        throw new Error('Compact Thrift binary field exceeds its budget')
      }
      requireBytes(reader, length)
      reader.offset += length
      return undefined
    }
    case LIST: {
      const header = readByte(reader)
      const elementType = header & 0x0f
      const inlineLength = header >>> 4
      const length = inlineLength === 15 ? readUnsignedNumber(reader, 5) : inlineLength
      if (
        length > reader.options.maxCollectionLength ||
        length > reader.options.maxTotalCollectionElements - reader.totalCollectionElements
      ) {
        throw new Error('Compact Thrift collection exceeds its budget')
      }
      reader.totalCollectionElements += length
      for (let index = 0; index < length; index += 1) {
        scanElement(
          reader,
          elementType === TRUE || elementType === FALSE ? BYTE : elementType,
          depth + 1,
          `${path}[]`,
        )
      }
      return undefined
    }
    case STRUCT:
      scanStruct(reader, depth + 1, path)
      return undefined
    default:
      throw new Error(`Compact Thrift type ${type} is unsupported`)
  }
}

function readZigZagNumber(reader: Reader, maxBytes: number): number {
  const encoded = readUnsignedBigInt(reader, maxBytes)
  const decoded = (encoded >> 1n) ^ -(encoded & 1n)
  const value = Number(decoded)
  if (!Number.isSafeInteger(value)) throw new Error('Compact Thrift integer is unsafe')
  return value
}

function readZigZagBigInt(reader: Reader): bigint {
  const encoded = readUnsignedBigInt(reader, 10)
  return (encoded >> 1n) ^ -(encoded & 1n)
}

function readUnsignedNumber(reader: Reader, maxBytes: number): number {
  const value = Number(readUnsignedBigInt(reader, maxBytes))
  if (!Number.isSafeInteger(value)) throw new Error('Compact Thrift length is unsafe')
  return value
}

function readUnsignedBigInt(reader: Reader, maxBytes: number): bigint {
  let value = 0n
  for (let index = 0; index < maxBytes; index += 1) {
    const byte = readByte(reader)
    value |= BigInt(byte & 0x7f) << BigInt(index * 7)
    if ((byte & 0x80) === 0) return value
  }
  throw new Error('Compact Thrift varint exceeds its budget')
}

function readByte(reader: Reader): number {
  requireBytes(reader, 1)
  const byte = reader.input[reader.offset]
  if (byte === undefined) throw new Error('Compact Thrift input is truncated')
  reader.offset += 1
  return byte
}

function requireBytes(reader: Reader, length: number): void {
  if (length < 0 || length > reader.input.byteLength - reader.offset) {
    throw new Error('Compact Thrift input is truncated')
  }
}
