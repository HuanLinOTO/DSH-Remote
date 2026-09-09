import { describe, expect, it } from 'vitest'
import { OAUTH_RETURN_TO, parseOAuthReturnUrl } from '../sessionStore'

describe('OAuth return URL parsing', () => {
  it('accepts the documented dshremote://oauth redirect with a token', () => {
    expect(parseOAuthReturnUrl('dshremote://oauth?token=account-token-123456')).toEqual({
      token: 'account-token-123456',
    })
  })

  it('surfaces the server error code on a rejected authorization', () => {
    expect(parseOAuthReturnUrl('dshremote://oauth?error=oauth_not_configured')).toEqual({
      error: 'oauth_not_configured',
    })
  })

  it('rejects URLs that are not the OAuth return scheme', () => {
    expect(parseOAuthReturnUrl('https://dsh.r2049.cn/app?token=account-token-123456')).toBeUndefined()
    expect(parseOAuthReturnUrl('dshremote://devices?token=account-token-123456')).toBeUndefined()
    expect(parseOAuthReturnUrl('not a url')).toBeUndefined()
  })

  it('keeps the canonical return_to constant aligned with the original Android client', () => {
    expect(OAUTH_RETURN_TO).toBe('dshremote://oauth')
  })
})
