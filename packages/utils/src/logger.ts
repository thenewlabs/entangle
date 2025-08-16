import pino from 'pino';
import { Writable } from 'stream';
import { OutputHandler, parseOutputMode } from './output.js';

interface LoggerWithOutput extends pino.Logger {
  outputHandler?: OutputHandler;
}

export function createLogger(name: string, outputMode?: string): pino.Logger {
  const level = process.env.LOG_LEVEL || 'info';
  const mode = parseOutputMode(outputMode || process.env.OUTPUT_MODE);
  const outputHandler = new OutputHandler({ mode });
  
  // Create a custom writable stream that routes Pino logs through OutputHandler
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      try {
        const str = typeof chunk === 'string' ? chunk : chunk.toString();
        const obj = JSON.parse(str);
        const { level: lvl, msg, ...data } = obj as any;
        
        // Convert pino numeric level to name; if already a string, keep it
        const levelName = typeof lvl === 'number' 
          ? (pino.levels.labels[lvl as keyof typeof pino.levels.labels] || 'info')
          : (typeof lvl === 'string' ? (lvl as string) : 'info');
        
        // Remove boilerplate fields
        if ((data as any).name === name) delete (data as any).name;
        delete (data as any).time;
        delete (data as any).pid;
        delete (data as any).hostname;
        
        const hasData = Object.keys(data).length > 0;
        outputHandler.log(levelName, msg, hasData ? data : undefined);
      } catch (_err) {
        // Fallback for non-JSON chunk
        const str = typeof chunk === 'string' ? chunk : chunk.toString();
        outputHandler.write(str);
      } finally {
        callback();
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
    destination as unknown as pino.DestinationStream
  ) as LoggerWithOutput;
  
  // Attach outputHandler for direct access if needed
  logger.outputHandler = outputHandler;
  
  return logger;
}
