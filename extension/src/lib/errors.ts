import { ApiError } from '../api/client';
import type { Translate } from './i18n';

export interface ErrorContext {
  /** A Cloudflare Access service token is configured (changes the access_blocked hint). */
  accessTokenSet?: boolean;
}

/** One human sentence for any error thrown by the API layer. */
export function describeError(err: unknown, t: Translate, ctx: ErrorContext = {}): string {
  if (!(err instanceof ApiError)) return t('errGeneric', [err instanceof Error ? err.message : String(err)]);
  switch (err.code) {
    case 'access_blocked':
      return ctx.accessTokenSet ? t('errAccessRejected') : t('errAccessBlocked');
    case 'unauthorized':
      return t('errUnauthorized');
    case 'network':
      return t('errNetwork');
    case 'timeout':
      return t('errTimeout');
    case 'locked':
      return t('errLocked', [String(err.details?.actor ?? '?')]);
    case 'rate_limited':
      return t('errRateLimited');
    case 'forbidden':
      return t('errForbidden', [err.message]);
    case 'not_found':
      return t('errNotFound');
    case 'validation':
      return t('errValidation', [err.message]);
    case 'unavailable':
      return t('errUnavailable');
    default:
      return t('errGeneric', [err.message]);
  }
}

/** Errors that mean "the user must fix settings", as opposed to transient trouble. */
export function needsSettingsFix(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'unauthorized' || err.code === 'access_blocked');
}

export function isOfflineError(err: unknown): boolean {
  return err instanceof ApiError && (err.code === 'network' || err.code === 'timeout');
}
