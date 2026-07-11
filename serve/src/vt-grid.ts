/**
 * A deliberately small VT100/xterm screen buffer.
 *
 * It exists so the host can render the shared shell *offset inside a box*: a raw
 * shell writes at absolute column 1, which would paint over a left rail, so we
 * parse its output into a grid and repaint that grid into the box interior. It
 * supports the escapes a shell and common line/TUI apps emit (cursor motion,
 * erase, SGR colours, scrolling); exotic sequences are ignored rather than
 * mis-rendered. It is pure (no I/O) so it can be unit-tested directly.
 */
interface Cell {
  ch: string;
  sgr: string; // active SGR sequence when the char was written ('' = default)
}

function blankCell(): Cell {
  return { ch: ' ', sgr: '' };
}

export class VtGrid {
  cols: number;
  rows: number;
  cursorX = 0;
  cursorY = 0;
  private grid: Cell[][];
  private sgr = ''; // accumulated active SGR since the last reset
  private savedX = 0;
  private savedY = 0;
  private pending = ''; // incomplete escape sequence carried across writes

  constructor(cols: number, rows: number) {
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.grid = this.blankGrid(this.cols, this.rows);
  }

  private blankGrid(cols: number, rows: number): Cell[][] {
    return Array.from({ length: rows }, () =>
      Array.from({ length: cols }, blankCell),
    );
  }

  /** Resize, preserving as much top-left content as fits. */
  resize(cols: number, rows: number): void {
    cols = Math.max(1, cols);
    rows = Math.max(1, rows);
    const next = this.blankGrid(cols, rows);
    for (let y = 0; y < Math.min(rows, this.rows); y++) {
      for (let x = 0; x < Math.min(cols, this.cols); x++) {
        next[y]![x] = this.grid[y]![x]!;
      }
    }
    this.grid = next;
    this.cols = cols;
    this.rows = rows;
    this.cursorX = Math.min(this.cursorX, cols - 1);
    this.cursorY = Math.min(this.cursorY, rows - 1);
  }

  write(data: string): void {
    let s = this.pending + data;
    this.pending = '';
    let i = 0;
    while (i < s.length) {
      const ch = s[i]!;
      if (ch === '\x1b') {
        const consumed = this.handleEscape(s, i);
        if (consumed === -1) {
          // Incomplete sequence at end of chunk — carry it to the next write.
          this.pending = s.slice(i);
          return;
        }
        i += consumed;
        continue;
      }
      this.handleControlOrPrintable(ch);
      i++;
    }
  }

  private handleEscape(s: string, i: number): number {
    const next = s[i + 1];
    if (next === undefined) return -1; // need more
    if (next === '[') {
      // CSI: ESC [ params interm final
      let j = i + 2;
      let params = '';
      while (j < s.length) {
        const c = s[j]!;
        if (c >= '\x40' && c <= '\x7e') {
          this.handleCsi(params, c);
          return j - i + 1;
        }
        params += c;
        j++;
      }
      return -1; // incomplete
    }
    if (next === ']') {
      // OSC: ESC ] ... (BEL | ESC \) — used for titles; consume and ignore.
      let j = i + 2;
      while (j < s.length) {
        if (s[j] === '\x07') return j - i + 1;
        if (s[j] === '\x1b' && s[j + 1] === '\\') return j - i + 2;
        j++;
      }
      return -1;
    }
    // Simple two-byte escapes.
    if (next === '7') { this.savedX = this.cursorX; this.savedY = this.cursorY; return 2; }
    if (next === '8') { this.cursorX = this.savedX; this.cursorY = this.savedY; return 2; }
    if (next === 'M') { this.reverseLineFeed(); return 2; }
    if (next === '=' || next === '>') return 2; // keypad modes
    if (next === '(' || next === ')') return s[i + 2] === undefined ? -1 : 3; // charset
    return 2; // unknown ESC X — skip both
  }

  private handleCsi(params: string, final: string): void {
    // Ignore private/DEC modes (e.g. ?25 cursor, ?2004 bracketed paste) and
    // scroll-region set — the host owns the frame region.
    if (params.startsWith('?')) return;
    const nums = params.split(';').map((p) => (p === '' ? undefined : parseInt(p, 10)));
    const n = (idx: number, def: number) => {
      const v = nums[idx];
      return v === undefined || Number.isNaN(v) ? def : v;
    };
    switch (final) {
      case 'H': case 'f':
        this.cursorY = this.clampY(n(0, 1) - 1);
        this.cursorX = this.clampX(n(1, 1) - 1);
        break;
      case 'A': this.cursorY = this.clampY(this.cursorY - n(0, 1)); break;
      case 'B': this.cursorY = this.clampY(this.cursorY + n(0, 1)); break;
      case 'C': this.cursorX = this.clampX(this.cursorX + n(0, 1)); break;
      case 'D': this.cursorX = this.clampX(this.cursorX - n(0, 1)); break;
      case 'G': this.cursorX = this.clampX(n(0, 1) - 1); break;
      case 'd': this.cursorY = this.clampY(n(0, 1) - 1); break;
      case 'J': this.eraseDisplay(n(0, 0)); break;
      case 'K': this.eraseLine(n(0, 0)); break;
      case 'm': this.applySgr(params); break;
      case 'L': this.insertLines(n(0, 1)); break;
      case 'M': this.deleteLines(n(0, 1)); break;
      case 'P': this.deleteChars(n(0, 1)); break;
      case '@': this.insertBlanks(n(0, 1)); break;
      case 's': this.savedX = this.cursorX; this.savedY = this.cursorY; break;
      case 'u': this.cursorX = this.savedX; this.cursorY = this.savedY; break;
      default: break; // unsupported CSI — ignore
    }
  }

  private applySgr(params: string): void {
    if (params === '' || params === '0') { this.sgr = ''; return; }
    // Accumulate active attributes; a reset (0) anywhere clears first.
    const parts = params.split(';');
    if (parts.includes('0')) this.sgr = '';
    this.sgr += `\x1b[${params}m`;
  }

  private handleControlOrPrintable(ch: string): void {
    const code = ch.charCodeAt(0);
    if (code === 0x0a) { this.lineFeed(); return; }          // LF
    if (code === 0x0d) { this.cursorX = 0; return; }         // CR
    if (code === 0x08) { this.cursorX = this.clampX(this.cursorX - 1); return; } // BS
    if (code === 0x09) {                                     // TAB
      this.cursorX = this.clampX((Math.floor(this.cursorX / 8) + 1) * 8);
      return;
    }
    if (code === 0x07) return;                               // BEL
    if (code < 0x20) return;                                 // other control chars
    // Printable
    if (this.cursorX >= this.cols) { this.cursorX = 0; this.lineFeed(); }
    this.grid[this.cursorY]![this.cursorX] = { ch, sgr: this.sgr };
    this.cursorX++;
  }

  private lineFeed(): void {
    if (this.cursorY >= this.rows - 1) this.scrollUp();
    else this.cursorY++;
  }

  private reverseLineFeed(): void {
    if (this.cursorY <= 0) this.scrollDown();
    else this.cursorY--;
  }

  private scrollUp(): void {
    this.grid.shift();
    this.grid.push(Array.from({ length: this.cols }, blankCell));
  }

  private scrollDown(): void {
    this.grid.pop();
    this.grid.unshift(Array.from({ length: this.cols }, blankCell));
  }

  private insertLines(count: number): void {
    for (let k = 0; k < count; k++) {
      this.grid.splice(this.rows - 1, 1);
      this.grid.splice(this.cursorY, 0, Array.from({ length: this.cols }, blankCell));
    }
  }

  private deleteLines(count: number): void {
    for (let k = 0; k < count; k++) {
      this.grid.splice(this.cursorY, 1);
      this.grid.splice(this.rows - 1, 0, Array.from({ length: this.cols }, blankCell));
    }
  }

  private deleteChars(count: number): void {
    const row = this.grid[this.cursorY]!;
    row.splice(this.cursorX, count);
    while (row.length < this.cols) row.push(blankCell());
  }

  private insertBlanks(count: number): void {
    const row = this.grid[this.cursorY]!;
    for (let k = 0; k < count; k++) row.splice(this.cursorX, 0, blankCell());
    row.length = this.cols;
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.grid = this.blankGrid(this.cols, this.rows);
      return;
    }
    if (mode === 0) {
      this.eraseLine(0);
      for (let y = this.cursorY + 1; y < this.rows; y++) this.grid[y] = Array.from({ length: this.cols }, blankCell);
    } else if (mode === 1) {
      this.eraseLine(1);
      for (let y = 0; y < this.cursorY; y++) this.grid[y] = Array.from({ length: this.cols }, blankCell);
    }
  }

  private eraseLine(mode: number): void {
    const row = this.grid[this.cursorY]!;
    const from = mode === 0 ? this.cursorX : 0;
    const to = mode === 1 ? this.cursorX + 1 : this.cols;
    for (let x = from; x < to && x < this.cols; x++) row[x] = blankCell();
  }

  private clampX(x: number): number { return Math.max(0, Math.min(this.cols - 1, x)); }
  private clampY(y: number): number { return Math.max(0, Math.min(this.rows - 1, y)); }

  /**
   * Render each row as a styled string exactly `cols` wide, with SGR runs
   * reconstructed and a reset at both ends so a row never bleeds style into the
   * box frame.
   */
  renderRows(): string[] {
    return this.grid.map((row) => {
      let out = '\x1b[0m';
      let active = '';
      for (const cell of row) {
        if (cell.sgr !== active) {
          out += '\x1b[0m' + cell.sgr;
          active = cell.sgr;
        }
        out += cell.ch;
      }
      out += '\x1b[0m';
      return out;
    });
  }

  /** Plain-text rows (no SGR) — handy for assertions/tests. */
  renderPlainRows(): string[] {
    return this.grid.map((row) => row.map((c) => c.ch).join(''));
  }
}
