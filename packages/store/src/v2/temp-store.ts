import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, statfs, unlink } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'
import { CapacityExceededError, IntegrityError } from '@databench/schema'
import { SemaphoreV2, throwIfAborted } from './runtime.js'

export const V2_TEMP_OWNER_MARKER = 'databench-v2-temp-v1\n'
export const DEFAULT_V2_TEMP_STALE_AGE_MS = 24 * 60 * 60 * 1000
export const DEFAULT_V2_TEMP_SAFETY_MARGIN_BYTES = 512 * 1024 * 1024

const TEMP_NAME_PATTERN =
  /^databench-v2-(?:prepare|read)-[0-9a-f-]{36}\.parquet$|^databench-v2-draft-(?:raw|output)-[0-9a-f-]{36}\.jsonl$/
const OWNER_CANDIDATE_PATTERN = /^\.databench-v2-owner-[0-9a-f-]{36}\.tmp$/

export type V2TempFileKind = 'prepare' | 'read' | 'draft-raw' | 'draft-output'

export interface V2TempStoreConfig {
  readonly tempRoot: string
  readonly staleAgeMs?: number
  readonly safetyMarginBytes?: number
}

export interface V2TempFile {
  readonly path: string
  readonly handle: Awaited<ReturnType<typeof open>>
  readonly device: bigint
  readonly inode: bigint
}

export interface V2TempReservation {
  readonly bytes: number
  resize(bytes: number, signal?: AbortSignal): Promise<void>
  release(): void
}

export class V2TempStore {
  readonly #root: string
  readonly #staleAgeMs: number
  readonly #safetyMarginBytes: number
  readonly #admission = new SemaphoreV2(1)
  #reservedBytes = 0
  #initialization: Promise<void> | undefined

  constructor(config: V2TempStoreConfig) {
    validateTempRoot(config.tempRoot)
    this.#root = config.tempRoot
    this.#staleAgeMs = positiveSafeInteger(
      'staleAgeMs',
      config.staleAgeMs ?? DEFAULT_V2_TEMP_STALE_AGE_MS,
    )
    this.#safetyMarginBytes = nonNegativeSafeInteger(
      'safetyMarginBytes',
      config.safetyMarginBytes ?? DEFAULT_V2_TEMP_SAFETY_MARGIN_BYTES,
    )
  }

  async initialize(): Promise<void> {
    this.#initialization ??= this.#initializeOnce()
    return await this.#initialization
  }

  async reserve(bytes: number, signal?: AbortSignal): Promise<V2TempReservation> {
    const requested = nonNegativeSafeInteger('reservation bytes', bytes)
    await this.initialize()
    const releaseAdmission = await this.#admission.acquire(signal)
    try {
      throwIfAborted(signal)
      const stats = await statfs(this.#root, { bigint: true })
      throwIfAborted(signal)
      const available = stats.bavail * stats.bsize
      const required =
        BigInt(this.#reservedBytes) + BigInt(requested) + BigInt(this.#safetyMarginBytes)
      if (available < required) {
        throw new CapacityExceededError('Insufficient V2 temporary storage capacity', {
          resource: 'temp_disk_bytes',
          required: required.toString(),
          available: available.toString(),
        })
      }
      this.#reservedBytes = checkedAdd(this.#reservedBytes, requested)
    } finally {
      releaseAdmission()
    }

    let currentBytes = requested
    let released = false
    return Object.freeze({
      get bytes() {
        return currentBytes
      },
      resize: async (bytes: number, resizeSignal?: AbortSignal) => {
        if (released) {
          throw new TypeError('V2 temporary storage reservation has already been released')
        }
        const nextBytes = nonNegativeSafeInteger('reservation bytes', bytes)
        if (nextBytes === currentBytes) return
        const releaseResizeAdmission = await this.#admission.acquire(resizeSignal)
        try {
          if (released) {
            throw new TypeError('V2 temporary storage reservation has already been released')
          }
          throwIfAborted(resizeSignal)
          if (nextBytes > currentBytes) {
            const stats = await statfs(this.#root, { bigint: true })
            if (released) {
              throw new TypeError('V2 temporary storage reservation has already been released')
            }
            throwIfAborted(resizeSignal)
            const available = stats.bavail * stats.bsize
            const growth = nextBytes - currentBytes
            const required =
              BigInt(this.#reservedBytes) + BigInt(growth) + BigInt(this.#safetyMarginBytes)
            if (available < required) {
              throw new CapacityExceededError('Insufficient V2 temporary storage capacity', {
                resource: 'temp_disk_bytes',
                required: required.toString(),
                available: available.toString(),
              })
            }
            this.#reservedBytes = checkedAdd(this.#reservedBytes, growth)
          } else {
            this.#reservedBytes -= currentBytes - nextBytes
          }
          currentBytes = nextBytes
        } finally {
          releaseResizeAdmission()
        }
      },
      release: () => {
        if (released) return
        released = true
        this.#reservedBytes -= currentBytes
      },
    })
  }

  async create(kind: V2TempFileKind, signal?: AbortSignal): Promise<V2TempFile> {
    await this.initialize()
    throwIfAborted(signal)
    const extension = kind === 'prepare' || kind === 'read' ? 'parquet' : 'jsonl'
    const path = join(this.#root, `databench-v2-${kind}-${randomUUID()}.${extension}`)
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    )
    try {
      await handle.chmod(0o600)
      throwIfAborted(signal)
      const stats = await handle.stat({ bigint: true })
      throwIfAborted(signal)
      return Object.freeze({ path, handle, device: stats.dev, inode: stats.ino })
    } catch (error) {
      await handle.close().catch(() => undefined)
      await unlink(path).catch(() => undefined)
      throw error
    }
  }

  async remove(file: V2TempFile): Promise<void> {
    await file.handle.close().catch(() => undefined)
    const stats = await lstat(file.path, { bigint: true }).catch((error: unknown) => {
      if (isErrno(error, 'ENOENT')) return null
      throw error
    })
    if (stats === null) return
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.dev !== file.device ||
      stats.ino !== file.inode
    ) {
      throw new IntegrityError('V2 temporary file path no longer references its original file', {
        reason: 'temp_file_replaced',
      })
    }
    await unlink(file.path).catch((error: unknown) => {
      if (!isErrno(error, 'ENOENT')) throw error
    })
  }

  async #initializeOnce(): Promise<void> {
    const before = await lstat(this.#root).catch((error: unknown) => {
      if (isErrno(error, 'ENOENT')) return null
      throw error
    })
    if (before?.isSymbolicLink() || (before !== null && !before.isDirectory())) {
      throw new IntegrityError('V2 temporary root must be a real directory', {
        reason: 'temp_root_not_directory',
      })
    }
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    const rootHandle = await open(
      this.#root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    ).catch((error: unknown) => {
      if (isErrno(error, 'ELOOP')) {
        throw new IntegrityError('V2 temporary root must not be a symbolic link', {
          reason: 'temp_root_symlink',
        })
      }
      throw error
    })
    try {
      const rootStats = await rootHandle.stat()
      if (!rootStats.isDirectory()) {
        throw new IntegrityError('V2 temporary root must be a real directory', {
          reason: 'temp_root_not_directory',
        })
      }
      await rootHandle.chmod(0o700)
    } finally {
      await rootHandle.close()
    }
    const markerPath = join(this.#root, '.databench-v2-owner')
    const candidatePath = join(this.#root, `.databench-v2-owner-${randomUUID()}.tmp`)
    try {
      const candidate = await open(
        candidatePath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        await candidate.writeFile(V2_TEMP_OWNER_MARKER, 'utf8')
        await candidate.sync()
      } finally {
        await candidate.close()
      }
      try {
        await link(candidatePath, markerPath)
      } catch (error) {
        if (!isErrno(error, 'EEXIST')) throw error
      }
    } finally {
      await unlink(candidatePath).catch(() => undefined)
    }

    {
      const marker = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
        (error: unknown) => {
          if (isErrno(error, 'ELOOP')) {
            throw new IntegrityError('V2 temporary root owner marker must not be a symbolic link', {
              reason: 'temp_owner_marker_symlink',
            })
          }
          throw error
        },
      )
      try {
        const markerStats = await marker.stat()
        const existing = await marker.readFile('utf8')
        if (!markerStats.isFile() || existing !== V2_TEMP_OWNER_MARKER) {
          throw new IntegrityError('V2 temporary root owner marker is invalid', {
            reason: 'temp_owner_marker_mismatch',
          })
        }
        await marker.chmod(0o600)
      } finally {
        await marker.close()
      }
    }

    const now = Date.now()
    for (const entry of await readdir(this.#root, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        (!TEMP_NAME_PATTERN.test(entry.name) && !OWNER_CANDIDATE_PATTERN.test(entry.name))
      ) {
        continue
      }
      const path = join(this.#root, entry.name)
      const stats = await lstat(path, { bigint: true }).catch((error: unknown) => {
        if (isErrno(error, 'ENOENT')) return null
        throw error
      })
      if (stats === null) continue
      if (!stats.isFile() || stats.isSymbolicLink()) continue
      const ageMs = now - Number(stats.mtimeMs)
      if (ageMs >= this.#staleAgeMs) {
        await unlink(path).catch((error: unknown) => {
          if (!isErrno(error, 'ENOENT')) throw error
        })
      }
    }
  }
}

function validateTempRoot(value: string): void {
  if (typeof value !== 'string' || !isAbsolute(value) || value === parse(value).root) {
    throw new TypeError('V2 tempRoot must be a non-root absolute path')
  }
}

function positiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}

function nonNegativeSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`)
  }
  return value
}

function checkedAdd(left: number, right: number): number {
  if (right > Number.MAX_SAFE_INTEGER - left) {
    throw new CapacityExceededError('V2 temporary storage reservation exceeds safe range')
  }
  return left + right
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
