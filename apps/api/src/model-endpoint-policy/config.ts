import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import ipaddr from 'ipaddr.js'
import { z } from 'zod'

const MAX_POLICY_BYTES = 256 * 1024

const HostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .refine(isCanonicalPolicyHostname, 'hostname must be a canonical lowercase ASCII host or IP')

const CidrSchema = z
  .string()
  .min(3)
  .max(64)
  .refine((value) => {
    try {
      const [address] = ipaddr.parseCIDR(value)
      return !isIpv4Mapped(address)
    } catch {
      return false
    }
  }, 'cidr must be a valid IPv4 or IPv6 network')

const PortSchema = z.number().int().min(1).max(65_535)
const SchemeSchema = z.enum(['http', 'https'])

export const ModelEndpointPrivateRuleV1Schema = z
  .object({
    hostname: HostnameSchema,
    cidrs: z.array(CidrSchema).min(1).max(32),
    schemes: z.array(SchemeSchema).min(1).max(2),
    ports: z.array(PortSchema).min(1).max(16),
  })
  .strict()
  .superRefine(assertUniqueRuleValues)

export const ModelEndpointPublicRuleV1Schema = z
  .object({
    hostname: HostnameSchema,
    ports: z.array(PortSchema).min(1).max(16),
  })
  .strict()
  .superRefine((value, context) => assertUniqueArray(value.ports, 'ports', context))

export const ModelEndpointPolicyV1Schema = z
  .object({
    profile: z.literal('model-endpoint-policy-v1'),
    generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    private_network: z.array(ModelEndpointPrivateRuleV1Schema).max(256),
    public_network: z.array(ModelEndpointPublicRuleV1Schema).max(256),
  })
  .strict()

export type ModelEndpointPrivateRuleV1 = z.infer<typeof ModelEndpointPrivateRuleV1Schema>
export type ModelEndpointPublicRuleV1 = z.infer<typeof ModelEndpointPublicRuleV1Schema>
export type ModelEndpointPolicyV1 = z.infer<typeof ModelEndpointPolicyV1Schema>

export const DENY_ALL_MODEL_ENDPOINT_POLICY_V1: Readonly<ModelEndpointPolicyV1> = Object.freeze({
  profile: 'model-endpoint-policy-v1',
  generation: 1,
  private_network: [],
  public_network: [],
})

export function parseModelEndpointPolicyV1(value: unknown): Readonly<ModelEndpointPolicyV1> {
  return freezePolicy(ModelEndpointPolicyV1Schema.parse(value))
}

export function loadModelEndpointPolicyV1(path: string): Readonly<ModelEndpointPolicyV1> {
  if (!isAbsolute(path)) throw new TypeError('Model endpoint policy path must be absolute')
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw new TypeError('Model endpoint policy is unavailable')
  }
  let raw: Buffer
  try {
    const metadata = fstatSync(descriptor)
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_POLICY_BYTES) {
      throw new TypeError('Model endpoint policy exceeds its byte limit')
    }
    raw = readFileSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw new TypeError('Model endpoint policy must be valid UTF-8 JSON')
  }
  return parseModelEndpointPolicyV1(value)
}

export function isCanonicalPolicyHostname(value: string): boolean {
  if (value !== value.toLowerCase() || value.endsWith('.') || value.includes('%')) return false
  const unwrapped = unwrapIpv6(value)
  if (ipaddr.isValid(unwrapped)) {
    const parsed = ipaddr.parse(unwrapped)
    if (isIpv4Mapped(parsed)) return false
    return canonicalAddress(parsed) === unwrapped
  }
  if (!/^[a-z0-9.-]+$/u.test(value) || value.includes('..')) return false
  const labels = value.split('.')
  return labels.every(
    (label) =>
      label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  )
}

export function canonicalAddress(address: ipaddr.IPv4 | ipaddr.IPv6): string {
  return address instanceof ipaddr.IPv6 ? address.toRFC5952String() : address.toString()
}

export function unwrapIpv6(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

export function isIpv4Mapped(address: ipaddr.IPv4 | ipaddr.IPv6): boolean {
  return address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress()
}

function assertUniqueRuleValues(
  value: z.infer<typeof ModelEndpointPrivateRuleV1Schema>,
  context: z.RefinementCtx,
): void {
  assertUniqueArray(value.cidrs, 'cidrs', context)
  assertUniqueArray(value.schemes, 'schemes', context)
  assertUniqueArray(value.ports, 'ports', context)
}

function assertUniqueArray(
  values: readonly (string | number)[],
  field: string,
  context: z.RefinementCtx,
): void {
  if (new Set(values).size === values.length) return
  context.addIssue({ code: 'custom', path: [field], message: `${field} must be unique` })
}

function freezePolicy(value: ModelEndpointPolicyV1): Readonly<ModelEndpointPolicyV1> {
  return Object.freeze({
    profile: value.profile,
    generation: value.generation,
    private_network: Object.freeze(
      value.private_network.map((rule) =>
        Object.freeze({
          hostname: rule.hostname,
          cidrs: Object.freeze([...rule.cidrs]),
          schemes: Object.freeze([...rule.schemes]),
          ports: Object.freeze([...rule.ports]),
        }),
      ),
    ),
    public_network: Object.freeze(
      value.public_network.map((rule) =>
        Object.freeze({ hostname: rule.hostname, ports: Object.freeze([...rule.ports]) }),
      ),
    ),
  }) as unknown as Readonly<ModelEndpointPolicyV1>
}
