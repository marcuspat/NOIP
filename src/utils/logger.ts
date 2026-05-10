import winston from 'winston';
import { config } from '../config';
import { getContext } from './request-context';

/**
 * Inject the active RequestContext (correlationId, userId, sessionId) into
 * every log entry. If no context is active (e.g. boot-time logs), the fields
 * are simply absent.
 *
 * Per ADR-0015.
 */
const correlationFormat = winston.format(info => {
  const ctx = getContext();
  if (ctx) {
    info.correlationId = ctx.correlationId;
    if (ctx.userId) info.userId = ctx.userId;
    if (ctx.sessionId) info.sessionId = ctx.sessionId;
  }
  return info;
});

const logger = winston.createLogger({
  level: config.app.logLevel,
  format: winston.format.combine(
    correlationFormat(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: {
    service: config.app.name,
    version: config.app.version,
    environment: config.app.environment,
  },
  transports: [
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      maxsize: 5242880,
      maxFiles: 5,
    }),
  ],
});

if (config.app.environment !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        correlationFormat(),
        winston.format.colorize(),
        winston.format.simple()
      ),
    })
  );
}

export { logger };
export default logger;
