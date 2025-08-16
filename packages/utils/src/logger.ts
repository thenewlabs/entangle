import pino from 'pino';
import { OutputHandler, parseOutputMode } from './output.js';

interface LoggerWithOutput extends pino.Logger {
  outputHandler?: OutputHandler;
}

export function createLogger(name: string, outputMode?: string): pino.Logger {
  const level = process.env.LOG_LEVEL || 'info';
  const mode = parseOutputMode(outputMode || process.env.OUTPUT_MODE);
  const outputHandler = new OutputHandler({ mode });
  
  // Create a custom destination that routes to OutputHandler
  const customDestination = pino.destination({
    write(chunk: string) {
      try {
        const obj = JSON.parse(chunk);
        const { level, msg, ...data } = obj;
        
        // Convert pino level numbers to names
        const levelName = pino.levels.labels[level as keyof typeof pino.levels.labels] || 'info';
        
        // Skip the 'name' field from data if it's just the logger name
        if (data.name === name) {
          delete data.name;
        }
        
        // Skip time, pid, hostname fields
        delete data.time;
        delete data.pid;
        delete data.hostname;
        
        // Only include data if there are meaningful fields
        const hasData = Object.keys(data).length > 0;
        outputHandler.log(levelName, msg, hasData ? data : undefined);
      } catch (err) {
        // Fallback for non-JSON output
        outputHandler.write(chunk);
      }
    }
  });
  
  const logger = pino(
    {
      name,
      level,
      formatters: {
        level: (label: string) => ({ level: label }),
      },
    },
    customDestination
  ) as LoggerWithOutput;
  
  // Attach outputHandler for direct access if needed
  logger.outputHandler = outputHandler;
  
  return logger;
}