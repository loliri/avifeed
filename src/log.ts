import pino from 'pino';

export const log = pino({
  level: process.env['RIS_LOG_LEVEL'] ?? 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'pid,hostname',
      translateTime: 'HH:MM:ss',
    },
  },
});
