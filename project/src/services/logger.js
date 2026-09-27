import { createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { config } from '../config.js';

const logFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  format.errors({ stack: true }),
  format.printf(({ timestamp, level, message, ...meta }) => {
    let metaStr = '';
    if (Object.keys(meta).length > 0) {
      metaStr = ' ' + JSON.stringify(meta);
    }
    return `${timestamp} [${level.toUpperCase()}]: ${message}${metaStr}`;
  })
);

const consoleTransport = new transports.Console({
  format: format.combine(
    format.colorize(),
    logFormat
  ),
});

const fileTransport = new DailyRotateFile({
  filename: 'logs/%DATE%-combined.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '14d',
  format: logFormat,
});

const errorTransport = new DailyRotateFile({
  filename: 'logs/%DATE%-error.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '30d',
  level: 'error',
  format: logFormat,
});

const toolCallsTransport = new DailyRotateFile({
  filename: 'logs/%DATE%-tool-calls.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '30d',
  level: 'info',
  format: logFormat,
});

export const logger = createLogger({
  level: config.nodeEnv === 'production' ? 'info' : 'debug',
  transports: [consoleTransport, fileTransport, errorTransport, toolCallsTransport],
});

export function logToolCall(data) {
  logger.info('TOOL_CALL', { category: 'tool_call', ...data });
}

export function logError(context, error) {
  logger.error(context, { 
    error: error.message, 
    stack: error.stack,
    ...(error.data || {})
  });
}