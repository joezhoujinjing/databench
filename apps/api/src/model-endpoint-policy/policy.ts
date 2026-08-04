import { lookup } from 'node:dns/promises'
import ipaddr from 'ipaddr.js'
import {
  canonicalAddress,
  isCanonicalPolicyHostname,
  isIpv4Mapped,
  type ModelEndpointPolicyV1,
  parseModelEndpointPolicyV1,
  unwrapIpv6,
} from './config.js'

export type ModelEndpointConnectivityScopeV1 = 'private_network' | 'public_network'
export type ModelEndpointReleaseProfileV1 = 'offline' | 'connected'

export interface AuthorizedModelEndpointV1 {
  readonly url: URL
  readonly hostname: string
  readonly port: number
  readonly addresses: readonly string[]
  readonly policyGeneration: number
  readonly scope: ModelEndpointConnectivityScopeV1
}

export interface AdmittedModelEndpointConfigurationV1 {
  readonly url: URL
  readonly hostname: string
  readonly port: number
  readonly policyGeneration: number
  readonly scope: ModelEndpointConnectivityScopeV1
}

interface MatchedModelEndpointConfigurationV1 extends AdmittedModelEndpointConfigurationV1 {
  readonly privateRules: Readonly<ModelEndpointPolicyV1>['private_network']
}

export type ModelEndpointResolverV1 = (hostname: string, port: number) => Promise<readonly string[]>

export class ModelEndpointPolicyError extends Error {
  readonly code: string

  constructor(code: string, message = 'Model endpoint was rejected by policy') {
    super(message)
    this.name = 'ModelEndpointPolicyError'
    this.code = code
  }
}

export class ModelEndpointPolicyV1Runtime {
  readonly #policy: Readonly<ModelEndpointPolicyV1>
  readonly #resolver: ModelEndpointResolverV1
  readonly #releaseProfile: ModelEndpointReleaseProfileV1

  constructor(
    policy: unknown,
    options: {
      readonly resolver?: ModelEndpointResolverV1
      readonly releaseProfile?: ModelEndpointReleaseProfileV1
    } = {},
  ) {
    this.#policy = parseModelEndpointPolicyV1(policy)
    this.#resolver = options.resolver ?? systemModelEndpointResolverV1
    this.#releaseProfile = options.releaseProfile ?? 'offline'
  }

  get generation(): number {
    return this.#policy.generation
  }

  admitConfiguration(
    rawUrl: string,
    scope: ModelEndpointConnectivityScopeV1,
  ): Readonly<AdmittedModelEndpointConfigurationV1> {
    const { privateRules: _privateRules, ...configuration } = this.#matchConfiguration(
      rawUrl,
      scope,
    )
    return Object.freeze(configuration)
  }

  async authorize(
    rawUrl: string,
    scope: ModelEndpointConnectivityScopeV1,
  ): Promise<Readonly<AuthorizedModelEndpointV1>> {
    const configuration = this.#matchConfiguration(rawUrl, scope)
    const { url, hostname, port, privateRules } = configuration

    let rawAddresses: readonly string[]
    try {
      rawAddresses = await this.#resolver(hostname, port)
    } catch {
      throw new ModelEndpointPolicyError('model_endpoint_dns_rejected')
    }
    if (rawAddresses.length === 0 || rawAddresses.length > 64) {
      throw new ModelEndpointPolicyError('model_endpoint_dns_rejected')
    }
    const addresses: string[] = []
    for (const rawAddress of rawAddresses) {
      const address = parseCanonicalResolvedAddress(rawAddress)
      if (isAlwaysForbiddenAddress(address)) {
        throw new ModelEndpointPolicyError('model_endpoint_address_rejected')
      }
      if (scope === 'public_network') {
        if (!isGloballyRoutableAddress(address)) {
          throw new ModelEndpointPolicyError('model_endpoint_address_rejected')
        }
      } else if (
        !privateRules.some((rule) => rule.cidrs.some((cidr) => addressMatchesCidr(address, cidr)))
      ) {
        throw new ModelEndpointPolicyError('model_endpoint_address_rejected')
      }
      const canonical = canonicalAddress(address)
      if (!addresses.includes(canonical)) addresses.push(canonical)
    }
    if (addresses.length === 0) {
      throw new ModelEndpointPolicyError('model_endpoint_dns_rejected')
    }
    return Object.freeze({
      url,
      hostname,
      port,
      addresses: Object.freeze(addresses),
      policyGeneration: configuration.policyGeneration,
      scope,
    })
  }

  #matchConfiguration(
    rawUrl: string,
    scope: ModelEndpointConnectivityScopeV1,
  ): Readonly<MatchedModelEndpointConfigurationV1> {
    const url = parseModelEndpointUrlV1(rawUrl)
    const hostname = normalizeUrlHostname(url.hostname)
    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
    const scheme = url.protocol.slice(0, -1) as 'http' | 'https'

    if (scope === 'public_network' && this.#releaseProfile !== 'connected') {
      throw new ModelEndpointPolicyError(
        'model_endpoint_public_network_disabled',
        'Public-network model endpoints are unavailable in the offline release profile',
      )
    }

    const privateRules = this.#policy.private_network.filter(
      (rule) =>
        scope === 'private_network' &&
        rule.hostname === hostname &&
        rule.schemes.includes(scheme) &&
        rule.ports.includes(port),
    )
    const publicRules = this.#policy.public_network.filter(
      (rule) =>
        scope === 'public_network' &&
        scheme === 'https' &&
        rule.hostname === hostname &&
        rule.ports.includes(port),
    )
    if (privateRules.length === 0 && publicRules.length === 0) {
      throw new ModelEndpointPolicyError('model_endpoint_host_rejected')
    }
    return Object.freeze({
      url,
      hostname,
      port,
      policyGeneration: this.#policy.generation,
      scope,
      privateRules,
    })
  }
}

export async function systemModelEndpointResolverV1(
  hostname: string,
  port: number,
): Promise<readonly string[]> {
  const literal = unwrapIpv6(hostname)
  if (ipaddr.isValid(literal)) return [literal]
  const answers = await lookup(hostname, { all: true, verbatim: true })
  void port
  return answers.map((answer) => answer.address)
}

export function parseModelEndpointUrlV1(rawUrl: string): URL {
  if (
    typeof rawUrl !== 'string' ||
    rawUrl.length === 0 ||
    rawUrl.length > 2_048 ||
    hasForbiddenUrlCharacter(rawUrl) ||
    !hasCanonicalRawUrlAuthority(rawUrl)
  ) {
    throw new ModelEndpointPolicyError('model_endpoint_url_rejected')
  }
  let url: URL
  try {
    url = new URL(rawUrl)
    if (url.port !== '') void Number(url.port)
  } catch {
    throw new ModelEndpointPolicyError('model_endpoint_url_rejected')
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.hostname === '' ||
    !isCanonicalPolicyHostname(normalizeUrlHostname(url.hostname))
  ) {
    throw new ModelEndpointPolicyError('model_endpoint_url_rejected')
  }
  return url
}

function hasForbiddenUrlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint === undefined || codePoint <= 0x20 || codePoint === 0x7f || character === '\\') {
      return true
    }
  }
  return false
}

function hasCanonicalRawUrlAuthority(rawUrl: string): boolean {
  const prefixLength = rawUrl.startsWith('http://')
    ? 'http://'.length
    : rawUrl.startsWith('https://')
      ? 'https://'.length
      : 0
  if (prefixLength === 0) return false
  const authority = rawUrl.slice(prefixLength).split(/[/?#]/u, 1)[0]
  return (
    authority !== undefined &&
    authority.length > 0 &&
    /^[\x21-\x7e]+$/u.test(authority) &&
    authority === authority.toLowerCase()
  )
}

export function normalizeUrlHostname(value: string): string {
  return unwrapIpv6(value).toLowerCase()
}

function parseCanonicalResolvedAddress(raw: string): ipaddr.IPv4 | ipaddr.IPv6 {
  try {
    if (raw.includes('%')) throw new Error('zone IDs are forbidden')
    const address = ipaddr.parse(raw)
    if (isIpv4Mapped(address) || canonicalAddress(address).toLowerCase() !== raw.toLowerCase()) {
      throw new Error('non-canonical address')
    }
    return address
  } catch {
    throw new ModelEndpointPolicyError('model_endpoint_dns_rejected')
  }
}

function isAlwaysForbiddenAddress(address: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  const range = address.range()
  if (range === 'unspecified' || range === 'multicast' || range === 'linkLocal') return true
  return address.kind() === 'ipv4' && address.toString() === '169.254.169.254'
}

function isGloballyRoutableAddress(address: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  return address.range() === 'unicast'
}

function addressMatchesCidr(address: ipaddr.IPv4 | ipaddr.IPv6, cidr: string): boolean {
  const [network, prefix] = ipaddr.parseCIDR(cidr)
  return address.kind() === network.kind() && address.match(network, prefix)
}
