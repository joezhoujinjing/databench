import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { openModelRepositoryRuntimeV2 } from '../src/v2/model-repository.js'

const temporaryRoots: string[] = []
const OBSERVED_AT = new Date('2026-08-04T12:00:00.000Z')

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('Model Repository runtime', () => {
  test('keeps offline ModelScope inspection at zero DNS/HTTP', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const runtime = await openModelRepositoryRuntimeV2({
      mode: 'offline',
      modelScopeFetch: fetchMock,
      clock: () => OBSERVED_AT,
    })
    await expect(
      runtime.resolve({
        provider: 'modelscope',
        repositoryId: 'Qwen/Qwen3-0.6B',
        revision: 'main',
        revisionKind: 'tag',
      }),
    ).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test.each([
    [
      'commit',
      '0123456789abcdef0123456789abcdef01234567',
      '0123456789abcdef0123456789abcdef01234567',
    ],
    ['digest', 'a'.repeat(64), 'a'.repeat(64)],
    ['tag', 'main', '09b42cad'],
    ['opaque', 'release-channel', '09b42cad'],
  ] as const)('resolves ModelScope %s references through only the exact bounded allowlist', async (revisionKind, revision, observedRevision) => {
    const requested: string[] = []
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      requested.push(url.href)
      expect(url.origin).toBe('https://www.modelscope.cn')
      expect(init).toMatchObject({
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      })
      if (url.pathname.endsWith('/repo/files')) {
        expect(url.searchParams.get('Revision')).toBe(revision)
        return Response.json({
          Code: 200,
          Success: true,
          Data: { Files: [], LatestCommitter: { ShortId: '09b42cad' } },
        })
      }
      return Response.json({
        Code: 200,
        Success: true,
        Data: { License: 'apache-2.0', Revision: 'main' },
      })
    })
    const runtime = await openModelRepositoryRuntimeV2({
      mode: 'connected',
      modelScopeFetch: fetchMock,
      clock: () => OBSERVED_AT,
    })
    await expect(
      runtime.resolve({
        provider: 'modelscope',
        repositoryId: 'Qwen/Qwen3-0.6B',
        revision,
        revisionKind,
      }),
    ).resolves.toMatchObject({
      adapter: 'modelscope',
      adapter_version: '1',
      observed_revision: observedRevision,
      observed_at: OBSERVED_AT.toISOString(),
      result: 'verified',
      license: 'apache-2.0',
      cache_status: 'not_cached',
      response_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(requested).toHaveLength(2)
    expect(
      requested.every((url) => url.startsWith('https://www.modelscope.cn/api/v1/models/')),
    ).toBe(true)
  })

  test('bounds provider responses and stores no raw provider body', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        Code: 200,
        Success: true,
        Data: { payload: 'x'.repeat(256 * 1024) },
      }),
    )
    const runtime = await openModelRepositoryRuntimeV2({
      mode: 'connected',
      modelScopeFetch: fetchMock,
      clock: () => OBSERVED_AT,
    })
    const observation = await runtime.resolve({
      provider: 'modelscope',
      repositoryId: 'Qwen/Qwen3-0.6B',
      revision: 'main',
      revisionKind: 'tag',
    })
    expect(observation).toMatchObject({ result: 'unavailable', response_digest: null })
    expect(JSON.stringify(observation)).not.toContain('xxxx')

    for (const response of [
      new Response('{"Code":200}', { headers: { 'content-type': 'text/plain' } }),
      Response.json(
        { Code: 200, Success: true, Data: {} },
        { headers: { 'x-large': 'é'.repeat(9_000) } },
      ),
    ]) {
      const boundedRuntime = await openModelRepositoryRuntimeV2({
        mode: 'connected',
        modelScopeFetch: vi.fn(async () => response.clone()),
        clock: () => OBSERVED_AT,
      })
      await expect(
        boundedRuntime.resolve({
          provider: 'modelscope',
          repositoryId: 'Qwen/Qwen3-0.6B',
          revision: 'main',
          revisionKind: 'tag',
        }),
      ).resolves.toMatchObject({ result: 'unavailable', response_digest: null })
    }
  })

  test('verifies an operator-managed snapshot without projecting its real path', async () => {
    const fixture = await operatorFixture()
    const runtime = await openModelRepositoryRuntimeV2({
      mode: 'offline',
      operatorConfigPath: fixture.configPath,
      clock: () => OBSERVED_AT,
    })
    const observation = await runtime.resolve({
      provider: 'operator_managed',
      repositoryId: 'local-qwen',
      revision: fixture.revision,
      revisionKind: 'commit',
    })
    expect(observation).toMatchObject({
      adapter: 'operator-managed',
      result: 'verified',
      observed_revision: fixture.revision,
      cache_status: 'cached',
      license: 'apache-2.0',
    })
    expect(JSON.stringify(observation)).not.toContain(fixture.root)
  })

  test('rejects traversal, symlink, special-file, and snapshot-race configurations', async () => {
    const sandbox = await newTemporaryRoot()
    const allowed = join(sandbox, 'allowed')
    const outside = join(sandbox, 'outside')
    await Promise.all([mkdir(allowed), mkdir(outside)])
    const traversalConfig = join(sandbox, 'traversal.json')
    await writeConfig(traversalConfig, allowed, outside)
    await expect(
      openModelRepositoryRuntimeV2({ operatorConfigPath: traversalConfig }),
    ).rejects.toThrow(/escapes/i)

    const linkedConfig = join(sandbox, 'linked-config.json')
    await symlink(traversalConfig, linkedConfig)
    await expect(
      openModelRepositoryRuntimeV2({ operatorConfigPath: linkedConfig }),
    ).rejects.toThrow(/config.*regular file/i)

    const linked = join(allowed, 'linked')
    await symlink(outside, linked)
    const symlinkConfig = join(sandbox, 'symlink.json')
    await writeConfig(symlinkConfig, allowed, linked)
    await expect(
      openModelRepositoryRuntimeV2({ operatorConfigPath: symlinkConfig }),
    ).rejects.toThrow(/symlink/i)

    const specialRoot = join(allowed, 'special')
    await mkdir(specialRoot)
    await mkdir(join(specialRoot, '.databench-model-repository.json'))
    const specialConfig = join(sandbox, 'special.json')
    await writeConfig(specialConfig, allowed, specialRoot)
    await expect(
      openModelRepositoryRuntimeV2({ operatorConfigPath: specialConfig }),
    ).rejects.toThrow(/regular file/i)

    const race = await operatorFixture()
    const replacement = `${race.metadataPath}.replacement`
    await writeFile(replacement, operatorMetadata(race.revision), 'utf8')
    const runtime = await openModelRepositoryRuntimeV2({
      operatorConfigPath: race.configPath,
      clock: () => OBSERVED_AT,
      operatorAfterOpen: async () => {
        await rename(replacement, race.metadataPath)
      },
    })
    await expect(
      runtime.resolve({
        provider: 'operator_managed',
        repositoryId: 'local-qwen',
        revision: race.revision,
        revisionKind: 'commit',
      }),
    ).resolves.toMatchObject({ result: 'invalid', response_digest: null })
  })
})

async function operatorFixture() {
  const sandbox = await newTemporaryRoot()
  const allowed = join(sandbox, 'models')
  const root = join(allowed, 'qwen')
  await mkdir(root, { recursive: true })
  const revision = '0123456789abcdef0123456789abcdef01234567'
  const metadataPath = join(root, '.databench-model-repository.json')
  await writeFile(metadataPath, operatorMetadata(revision), 'utf8')
  const configPath = join(sandbox, 'providers.json')
  await writeConfig(configPath, allowed, root)
  return { configPath, metadataPath, revision, root }
}

function operatorMetadata(revision: string): string {
  return JSON.stringify({
    profile: 'operator-managed-model-repository-v1',
    repository_id: 'local-qwen',
    revision,
    revision_kind: 'commit',
    snapshot_digest: 'a'.repeat(64),
    license: 'apache-2.0',
  })
}

async function writeConfig(configPath: string, allowedRoot: string, repositoryRoot: string) {
  await writeFile(
    configPath,
    JSON.stringify({
      profile: 'model-repository-providers-v1',
      allowed_roots: [allowedRoot],
      repositories: [{ alias: 'local-qwen', root: repositoryRoot }],
    }),
    'utf8',
  )
}

async function newTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'databench-model-repository-'))
  temporaryRoots.push(root)
  return root
}
