export enum OutputMode {
  TEXT = 'text',
  STREAM_JSON = 'stream-json',
}

export interface OutputOptions {
  mode: OutputMode;
  timestamp?: boolean;
}

export class OutputHandler {
  private mode: OutputMode;
  private timestamp: boolean;

  constructor(options: OutputOptions = { mode: OutputMode.TEXT }) {
    this.mode = options.mode;
    this.timestamp = options.timestamp ?? false;
  }

  log(level: string, message: string, data?: any): void {
    const timestamp = this.timestamp ? new Date().toISOString() : undefined;
    
    switch (this.mode) {
      case OutputMode.TEXT:
        this.textOutput(level, message, data);
        break;
      
      case OutputMode.STREAM_JSON:
        this.jsonOutput(level, message, data, timestamp);
        break;
    }
  }

  info(message: string, data?: any): void {
    this.log('info', message, data);
  }

  error(message: string, data?: any): void {
    this.log('error', message, data);
  }

  debug(message: string, data?: any): void {
    this.log('debug', message, data);
  }

  warn(message: string, data?: any): void {
    this.log('warn', message, data);
  }

  // Direct output for things like command output
  write(data: string | Buffer): void {
    if (this.mode === OutputMode.TEXT) {
      process.stdout.write(data);
    } else {
      const output = {
        type: 'output',
        data: data.toString(),
        timestamp: this.timestamp ? new Date().toISOString() : undefined,
      };
      console.log(JSON.stringify(output));
    }
  }

  // Version output
  version(name: string, version: string): void {
    if (this.mode === OutputMode.TEXT) {
      console.log(`${name} ${version}`);
    } else {
      const output = {
        type: 'version',
        name,
        version,
        timestamp: this.timestamp ? new Date().toISOString() : undefined,
      };
      console.log(JSON.stringify(output));
    }
  }

  private textOutput(level: string, message: string, data?: any): void {
    // Format level with consistent width and color codes (if terminal supports)
    const levelFormatted = this.formatLevel(level);
    
    if (data && Object.keys(data).length > 0) {
      console.log(`${levelFormatted} ${message}`, data);
    } else {
      console.log(`${levelFormatted} ${message}`);
    }
  }

  private formatLevel(level: string): string {
    // Add color codes if we're in a TTY
    const isTTY = process.stdout.isTTY;
    const colors = {
      error: '\x1b[31m',   // Red
      warn: '\x1b[33m',    // Yellow
      info: '\x1b[36m',    // Cyan
      debug: '\x1b[90m',   // Gray
      reset: '\x1b[0m'
    };
    
    const levelUpper = level.toUpperCase().padEnd(5);
    
    if (isTTY && colors[level as keyof typeof colors]) {
      return `${colors[level as keyof typeof colors]}[${levelUpper}]${colors.reset}`;
    }
    
    return `[${levelUpper}]`;
  }

  private jsonOutput(level: string, message: string, data: any, timestamp?: string): void {
    const output = {
      type: 'log',
      level,
      message,
      ...(data && { data }),
      ...(timestamp && { timestamp }),
    };
    console.log(JSON.stringify(output));
  }
}

export function parseOutputMode(mode: string | undefined): OutputMode {
  switch (mode?.toLowerCase()) {
    case 'stream-json':
    case 'json':
      return OutputMode.STREAM_JSON;
    case 'text':
    default:
      return OutputMode.TEXT;
  }
}