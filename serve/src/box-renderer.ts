import type { VtGrid } from './vt-grid.js';

/**
 * Draws the shared shell inside a full-terminal "session frame": side rails, a
 * title bar naming the session and its viewer count, and a bottom bar showing
 * the URL to join. The shell itself is held in a {@link VtGrid} sized to the box
 * interior; this renderer only composes ANSI for one frame — it performs no I/O
 * so the host module owns all writes and lifecycle.
 *
 * The interior is `(cols - 2) x (rows - 2)` at terminal offset row 2, col 2, so
 * grid cell (x, y) maps to terminal (col x + 2, row y + 2).
 */

const TOP_LEFT = '╔';
const TOP_RIGHT = '╗';
const BOTTOM_LEFT = '╚';
const BOTTOM_RIGHT = '╝';
const HORIZONTAL = '═';
const VERTICAL = '║';

export class BoxRenderer {
  constructor(
    private grid: VtGrid,
    public cols: number,
    public rows: number,
  ) {}

  /** Interior width available to the shell (inside the side rails). */
  get innerCols(): number { return Math.max(1, this.cols - 2); }

  /** Interior height available to the shell (below the title, above the bar). */
  get innerRows(): number { return Math.max(1, this.rows - 2); }

  /** Update the total terminal size after a resize. */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  /**
   * Compose one complete frame: hides the cursor, repaints every border and
   * interior row from the grid, then re-places and shows the real cursor at the
   * grid's cursor position (offset into the box).
   */
  frame(state: { viewers: number; url: string | undefined }): string {
    const parts: string[] = ['\x1b[?25l\x1b[0m'];

    // Title bar.
    parts.push('\x1b[1;1H', this.topBorder(state.viewers));

    // Interior rows: rail + shell row + rail.
    const gridRows = this.grid.renderRows();
    for (let i = 0; i < this.innerRows; i++) {
      const row = gridRows[i] ?? ' '.repeat(this.innerCols);
      parts.push(`\x1b[${i + 2};1H`, VERTICAL, row, VERTICAL);
    }

    // Bottom bar.
    parts.push(`\x1b[${this.rows};1H`, this.bottomBorder(state.url));

    // Real cursor, clamped into the interior and offset by the frame.
    const cx = Math.min(Math.max(0, this.grid.cursorX), this.innerCols - 1) + 2;
    const cy = Math.min(Math.max(0, this.grid.cursorY), this.innerRows - 1) + 2;
    parts.push(`\x1b[${cy};${cx}H`, '\x1b[?25h');

    return parts.join('');
  }

  private topBorder(viewers: number): string {
    const label =
      `${TOP_LEFT}${HORIZONTAL} ⧉ entangle · shared · ` +
      `${viewers} viewer${viewers === 1 ? '' : 's'} `;
    return this.padBorder(label, TOP_RIGHT);
  }

  private bottomBorder(url: string | undefined): string {
    const shown = url ?? 'connecting…';
    return this.padBorder(`${BOTTOM_LEFT}${HORIZONTAL} ${shown} `, BOTTOM_RIGHT);
  }

  /**
   * Pad a border prefix (already including its leading corner) out to the full
   * terminal width with `═`, ending in `endCorner`. Over-long prefixes are
   * truncated so the line never exceeds the terminal width.
   */
  private padBorder(label: string, endCorner: string): string {
    const width = this.cols;
    if (label.length + 1 >= width) {
      return label.slice(0, Math.max(0, width - 1)) + endCorner;
    }
    return label + HORIZONTAL.repeat(width - label.length - 1) + endCorner;
  }
}
