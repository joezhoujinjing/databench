import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, test } from 'vitest'
import { ApiError } from '@/api/errors.js'
import i18n from '@/i18n/index.js'
import { detailMessages, InlineError, messageForError } from './State.js'

describe('error state helpers', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en')
  })

  test('surfaces ApiError code and message', () => {
    const error = new ApiError({ code: 'not_found', message: 'missing', status: 404 })

    expect(messageForError(error)).toBe('not_found - missing')
  })

  test('extracts per-field validation detail and strips pydantic value prefixes', () => {
    const error = new ApiError({
      body: {
        error: {
          detail: [{ msg: "Value error, alias 'x' maps twice" }, { msg: 'field required' }],
        },
      },
      code: 'validation_error',
      detail: [{ msg: "Value error, alias 'x' maps twice" }, { msg: 'field required' }],
      message: 'invalid',
      status: 422,
    })

    expect(detailMessages(error)).toEqual(["alias 'x' maps twice", 'field required'])
    expect(renderToStaticMarkup(<InlineError error={error} />)).toContain(
      'alias &#x27;x&#x27; maps twice',
    )
  })
})
