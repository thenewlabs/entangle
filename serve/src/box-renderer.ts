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
const SEP = '│';

/** Reverse-video wrap used to highlight the active window's tab. */
const REVERSE_ON = '\x1b[7m';
const REVERSE_OFF = '\x1b[27m';

/** A window as the tab bar needs to see it (index is positional). */
export interface TabInfo {
  title: string;
}

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
  frame(state: {
    viewers: number;
    url: string | undefined;
    windows: readonly TabInfo[];
    activeIndex: number;
  }): string {
    const parts: string[] = ['\x1b[?25l\x1b[0m'];

    // Title/tab bar.
    parts.push('\x1b[1;1H', this.topBorder(state.windows, state.activeIndex, state.viewers));

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

  /**
   * Top border doubling as the tab bar:
   *
   *   ╔═ ⧉ entangle │ ‹1:shell› 2:logs 3:build │ N viewers ═══╗
   *
   * The active tab is drawn in reverse video. Tabs take priority over the
   * viewer count: the count is only appended if it fits after the brand and
   * tabs, and the tab list itself is truncated with `…` at the terminal width.
   */
  private topBorder(windows: readonly TabInfo[], activeIndex: number, viewers: number): string {
    const budget = Math.max(0, this.cols - 1); // reserve the end corner
    const brand = `${TOP_LEFT}${HORIZONTAL} ⧉ entangle `;
    const viewerSeg = `${SEP} ${viewers} viewer${viewers === 1 ? '' : 's'} `;

    let styled = brand;
    let vis = brand.length;

    // Keep the viewer count only if the tabs still get a usable slice.
    const showViewers = budget - vis - viewerSeg.length >= 6;
    const tabsBudget = Math.max(0, budget - vis - (showViewers ? viewerSeg.length : 0));

    const tabs = this.renderTabs(windows, activeIndex, tabsBudget);
    styled += tabs.styled;
    vis += tabs.vis;

    if (showViewers) { styled += viewerSeg; vis += viewerSeg.length; }
    if (vis < budget) styled += HORIZONTAL.repeat(budget - vis);
    return styled + TOP_RIGHT;
  }

  /**
   * Render `│ 1:shell 2:logs …` into at most `maxVis` visible columns, the
   * active tab in reverse video, appending `…` if the list is truncated.
   * Returns the styled string and its visible width (SGR bytes excluded).
   */
  private renderTabs(
    windows: readonly TabInfo[],
    activeIndex: number,
    maxVis: number,
  ): { styled: string; vis: number } {
    if (maxVis <= 2 || windows.length === 0) return { styled: '', vis: 0 };
    let styled = `${SEP}`;
    let vis = 1;
    for (let i = 0; i < windows.length; i++) {
      const title = windows[i]!.title.replace(/[\x00-\x1f\x7f]/g, '');
      const token = ` ${i + 1}:${title} `;
      if (vis + token.length > maxVis) {
        // Not enough room: fit what we can, then an ellipsis, and stop.
        const remain = maxVis - vis - 1;
        if (remain > 0) {
          const slice = token.slice(0, remain);
          styled += i === activeIndex ? `${REVERSE_ON}${slice}${REVERSE_OFF}` : slice;
          vis += remain;
        }
        styled += '…';
        vis += 1;
        break;
      }
      styled += i === activeIndex ? `${REVERSE_ON}${token}${REVERSE_OFF}` : token;
      vis += token.length;
    }
    return { styled, vis };
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
