import pino from 'pino';

export function createLogger(name: string): pino.Logger {
  const level = process.env.LOG_LEVEL || 'info';
  
  return pino({
    name,
    level,
    formatters: {
      level: (label) => ({ level: label }),
    },
    transport: process.env.NODE_ENV === 'development' 
      ? {
          target: 'pino-pretty',
          options: {
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        }
      : undefined,
  });
}