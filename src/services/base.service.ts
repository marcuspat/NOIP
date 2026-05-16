import { v4 as uuidv4 } from 'uuid';
import { ServiceResponse } from '../types';
import logger from '../utils/logger';
import { messageOf } from '../shared/errors/from-unknown';
import { InternalError } from '../shared/errors';

export class BaseService {
  protected serviceName: string;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
  }

  protected createResponse<T>(
    success: boolean,
    data?: T,
    error?: string
  ): ServiceResponse<T> {
    // With `exactOptionalPropertyTypes: true` we cannot just spread
    // `undefined` into an optional field; assemble the envelope
    // conditionally so `data` / `error` are only present when set.
    const base: ServiceResponse<T> = {
      success,
      timestamp: new Date(),
      requestId: uuidv4(),
    };
    if (data !== undefined) {
      base.data = data;
    }
    if (error !== undefined) {
      base.error = error;
    }
    return base;
  }

  /**
   * Runs `operation` and returns its resolved value directly. On failure
   * the error is logged and rethrown as a typed `InternalError` so the
   * HTTP edge can map it via `toHttpResponse`.
   *
   * This is the replacement for the legacy `withErrorHandling` wrapper
   * that conflated transport (`ServiceResponse<T>`) with domain value.
   * Callers that need the wrapper shape can build it from the resolved
   * value or catch and reshape themselves.
   */
  protected async withTypedErrors<T>(
    operation: () => Promise<T>,
    errorMessage: string
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const message = messageOf(error);
      logger.error(`[${this.serviceName}] ${errorMessage}`, {
        error: message,
      });
      // Preserve the original error when it already carries domain
      // metadata (e.g. `DomainError`); otherwise wrap so the HTTP edge
      // still sees a typed failure.
      if (error instanceof Error) {
        throw error;
      }
      throw new InternalError(errorMessage, { cause: message });
    }
  }

  protected logOperation(operation: string, details?: unknown): void {
    console.log(`[${this.serviceName}] ${operation}`, details || '');
  }

  protected validateRequired(params: Record<string, unknown>): string[] {
    const missing: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') {
        missing.push(key);
      }
    }
    return missing;
  }
}
