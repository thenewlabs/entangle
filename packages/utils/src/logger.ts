import pino from 'pino';

export function createLogger(name: string): pino.Logger {
  const level = process.env.LOG_LEVEL || 'info';
  
  const baseConfig = {
    name,
    level,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  };
  
  if (process.env.NODE_ENV === 'development') {
    return pino({
      ...baseConfig,
      transport: {
        target: 'pino-pretty',
        options: {
          translateTime: 'HH:MM:ss',
          ignore: 'pid,hostname',
        },
      },
    });
  }
  
  return pino(baseConfig);
}