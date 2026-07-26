import {
  BadInputError,
  ResourceLimitError,
  UnsupportedProfileError,
  ValidationError,
} from '@databench/schema'

export interface CanonicalJsonlIssueV2 {
  readonly line: number
  readonly path: string
  readonly code: string
  readonly message: string
}

export interface CanonicalJsonlErrorDetailV2 {
  readonly issues: readonly CanonicalJsonlIssueV2[]
}

export class CanonicalJsonlBadInputErrorV2 extends BadInputError {
  override readonly name = 'CanonicalJsonlBadInputErrorV2'
  readonly issues: readonly CanonicalJsonlIssueV2[]

  constructor(issue: CanonicalJsonlIssueV2) {
    const issues = Object.freeze([Object.freeze({ ...issue })])
    super(`Canonical JSONL line ${issue.line} is malformed: ${issue.message}`, { issues })
    this.issues = issues
  }
}

export class CanonicalJsonlValidationErrorV2 extends ValidationError {
  override readonly name = 'CanonicalJsonlValidationErrorV2'
  readonly issues: readonly CanonicalJsonlIssueV2[]

  constructor(
    line: number,
    issuesInput: readonly Omit<CanonicalJsonlIssueV2, 'line'>[],
    format: 'canonical' | 'canonical-draft' = 'canonical',
  ) {
    const issues = Object.freeze(issuesInput.map((issue) => Object.freeze({ ...issue, line })))
    super(
      format === 'canonical'
        ? `Canonical JSONL line ${line} is not a valid v2 record`
        : `Canonical draft JSONL line ${line} is not a valid draft record`,
      { issues },
    )
    this.issues = issues
  }
}

export class CanonicalJsonlResourceLimitErrorV2 extends ResourceLimitError {
  override readonly name = 'CanonicalJsonlResourceLimitErrorV2'
  readonly issues: readonly CanonicalJsonlIssueV2[]

  constructor(
    issue: CanonicalJsonlIssueV2,
    resource: 'json_depth' | 'record_bytes',
    limit: number,
    actual: number | string,
  ) {
    const issues = Object.freeze([Object.freeze({ ...issue })])
    super(`Canonical JSONL line ${issue.line} exceeds the ${resource} limit`, {
      resource,
      limit,
      actual,
      issues,
    })
    this.issues = issues
  }
}

export class CanonicalJsonlUnsupportedRecordSchemaErrorV2 extends UnsupportedProfileError {
  override readonly name = 'CanonicalJsonlUnsupportedRecordSchemaErrorV2'
  readonly line: number
  readonly path = '/schema_version'
  readonly value: string

  constructor(line: number, value: string) {
    super(`Unsupported canonical record schema version: ${value}`, {
      kind: 'record_schema',
      value,
      supported: ['2.0.0'],
      issues: [
        {
          line,
          path: '/schema_version',
          code: 'unsupported_record_schema_version',
          message: `Unsupported canonical record schema version: ${value}`,
        },
      ],
    })
    this.line = line
    this.value = value
  }
}
