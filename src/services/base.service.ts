import { v4 as uuidv4 } from 'uuid';
import { ServiceResponse } from '../types';

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
    return {
      success,
      data,
      error,
      timestamp: new Date(),
      requestId: uuidv4(),
    };
  }

  protected async withErrorHandling<T>(
    operation: () => Promise<T>,
    errorMessage: string
  ): Promise<ServiceResponse<T>> {
    try {
      const data = await operation();
      return this.createResponse(true, data);
    } catch (error) {
      const message = error instanceof Error ? error.message : errorMessage;
      return this.createResponse<T>(false, undefined, message);
    }
  }

  protected logOperation(operation: string, details?: any): void {
    console.log(`[${this.serviceName}] ${operation}`, details || '');
  }

  protected validateRequired(params: Record<string, any>): string[] {
    const missing: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') {
        missing.push(key);
      }
    }
    return missing;
  }
}
