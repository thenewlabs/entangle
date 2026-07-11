import { describe, it, expect } from 'vitest';
import { VtGrid } from './vt-grid.js';

// Helper: strip trailing spaces from a plain row for readable assertions.
const trim = (s: string) => s.replace(/ +$/g, '');

describe('VtGrid — plain text writing', () => {
  it('renders written text top-left and advances cursorX', () => {
    const g = new VtGrid(10, 3);
    g.write('hi');
    const rows = g.renderPlainRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe('hi        '); // exactly cols (10) wide
    expect(rows[0]!.length).toBe(10);
    expect(g.cursorX).toBe(2);
    expect(g.cursorY).toBe(0);
  });

  it('every plain row is exactly cols wide', () => {
    const g = new VtGrid(7, 4);
    g.write('abc');
    for (const row of g.renderPlainRows()) expect(row.length).toBe(7);
  });
});

describe('VtGrid — CR / LF / CRLF', () => {
  it('CR resets the column to 0', () => {
    const g = new VtGrid(10, 3);
    g.write('abc\rX');
    expect(g.renderPlainRows()[0]).toBe('Xbc       ');
    expect(g.cursorX).toBe(1);
    expect(g.cursorY).toBe(0);
  });

  it('LF moves down without resetting the column (staircase)', () => {
    const g = new VtGrid(10, 3);
    g.write('a\nb');
    expect(g.cursorY).toBe(1);
    // 'a' at (0,0); LF -> y=1 keeping x=1; 'b' at (1,1)
    expect(trim(g.renderPlainRows()[0]!)).toBe('a');
    expect(g.renderPlainRows()[1]).toBe(' b        ');
  });

  it('CRLF starts the next line at column 0', () => {
    const g = new VtGrid(10, 3);
    g.write('one\r\ntwo');
    expect(trim(g.renderPlainRows()[0]!)).toBe('one');
    expect(trim(g.renderPlainRows()[1]!)).toBe('two');
    expect(g.cursorX).toBe(3);
    expect(g.cursorY).toBe(1);
  });
});

describe('VtGrid — cursor addressing', () => {
  it('ESC[H homes the cursor', () => {
    const g = new VtGrid(10, 4);
    g.write('abcdef');
    g.write('\x1b[H');
    expect(g.cursorX).toBe(0);
    expect(g.cursorY).toBe(0);
    g.write('Z');
    expect(g.renderPlainRows()[0]![0]).toBe('Z');
  });

  it('ESC[3;5H addresses row/col 1-based (assert via where text lands)', () => {
    const g = new VtGrid(10, 5);
    g.write('\x1b[3;5HZ');
    // row 3 (index 2), col 5 (index 4)
    expect(g.cursorY).toBe(2); // after writing Z at x=4, x advanced to 5
    expect(g.cursorX).toBe(5);
    expect(g.renderPlainRows()[2]![4]).toBe('Z');
  });

  it('CUU / CUD / CUF / CUB move relative to the cursor', () => {
    const g = new VtGrid(10, 6);
    g.write('\x1b[4;4H'); // y=3, x=3
    g.write('\x1b[2A'); // up 2 -> y=1
    expect(g.cursorY).toBe(1);
    g.write('\x1b[3B'); // down 3 -> y=4
    expect(g.cursorY).toBe(4);
    g.write('\x1b[2C'); // forward 2 -> x=5
    expect(g.cursorX).toBe(5);
    g.write('\x1b[3D'); // back 3 -> x=2
    expect(g.cursorX).toBe(2);
  });

  it('CUU/CUD default to 1 when no param given', () => {
    const g = new VtGrid(10, 6);
    g.write('\x1b[4;1H'); // y=3
    g.write('\x1b[A'); // up 1 -> y=2
    expect(g.cursorY).toBe(2);
    g.write('\x1b[B'); // down 1 -> y=3
    expect(g.cursorY).toBe(3);
  });

  it('CHA ESC[4G sets the column (1-based)', () => {
    const g = new VtGrid(10, 3);
    g.write('\x1b[4G');
    expect(g.cursorX).toBe(3);
    g.write('X');
    expect(g.renderPlainRows()[0]![3]).toBe('X');
  });

  it('VPA ESC[2d sets the row (1-based)', () => {
    const g = new VtGrid(10, 4);
    g.write('\x1b[2d');
    expect(g.cursorY).toBe(1);
    g.write('Y');
    expect(g.renderPlainRows()[1]![0]).toBe('Y');
  });

  it('cursor addressing clamps out-of-range targets', () => {
    const g = new VtGrid(5, 3);
    g.write('\x1b[99;99H');
    expect(g.cursorY).toBe(2); // rows-1
    expect(g.cursorX).toBe(4); // cols-1
  });
});

describe('VtGrid — erase display', () => {
  it('ESC[2J erases the whole screen', () => {
    const g = new VtGrid(6, 3);
    g.write('\x1b[1;1Haaa\x1b[2;1Hbbb\x1b[3;1Hccc');
    g.write('\x1b[2J');
    for (const row of g.renderPlainRows()) expect(trim(row)).toBe('');
  });

  it('ESC[0J erases from the cursor to the end of screen', () => {
    const g = new VtGrid(6, 3);
    g.write('\x1b[1;1HAAAAAA\x1b[2;1HBBBBBB\x1b[3;1HCCCCCC');
    g.write('\x1b[2;3H'); // row 2, col 3 (index x=2)
    g.write('\x1b[0J');
    const rows = g.renderPlainRows();
    expect(rows[0]).toBe('AAAAAA'); // untouched (above cursor)
    expect(rows[1]).toBe('BB    '); // from cursor col to end erased
    expect(trim(rows[2]!)).toBe(''); // whole row below erased
  });

  it('ESC[1J erases from start of screen to the cursor', () => {
    const g = new VtGrid(6, 3);
    g.write('\x1b[1;1HAAAAAA\x1b[2;1HBBBBBB\x1b[3;1HCCCCCC');
    g.write('\x1b[2;3H'); // row 2, index x=2
    g.write('\x1b[1J');
    const rows = g.renderPlainRows();
    expect(trim(rows[0]!)).toBe(''); // whole row above erased
    expect(rows[1]).toBe('   BBB'); // start-of-line through cursor (inclusive) erased
    expect(rows[2]).toBe('CCCCCC'); // untouched (below cursor)
  });
});

describe('VtGrid — erase line', () => {
  it('ESC[K erases from the cursor to the end of the line', () => {
    const g = new VtGrid(6, 2);
    g.write('ABCDEF');
    g.write('\x1b[1;3H'); // x=2
    g.write('\x1b[K');
    expect(g.renderPlainRows()[0]).toBe('AB    ');
  });

  it('ESC[1K erases from the start of the line through the cursor', () => {
    const g = new VtGrid(6, 2);
    g.write('ABCDEF');
    g.write('\x1b[1;3H'); // x=2
    g.write('\x1b[1K');
    expect(g.renderPlainRows()[0]).toBe('   DEF');
  });

  it('ESC[2K erases the whole line', () => {
    const g = new VtGrid(6, 2);
    g.write('ABCDEF');
    g.write('\x1b[1;3H');
    g.write('\x1b[2K');
    expect(trim(g.renderPlainRows()[0]!)).toBe('');
  });
});

describe('VtGrid — SGR colours', () => {
  it('coloured text carries the SGR sequence into renderRows', () => {
    const g = new VtGrid(6, 1);
    g.write('\x1b[31mR');
    const row = g.renderRows()[0]!;
    expect(row).toContain('\x1b[31m');
    // plain content unaffected
    expect(g.renderPlainRows()[0]![0]).toBe('R');
  });

  it('ESC[0m resets so later text has no colour', () => {
    const g = new VtGrid(6, 1);
    g.write('\x1b[31mA\x1b[0mB');
    const row = g.renderRows()[0]!;
    const aIdx = row.indexOf('A');
    const bIdx = row.indexOf('B');
    // colour appears at/before A
    expect(row.slice(0, aIdx)).toContain('31m');
    // no colour applied at or after B
    expect(row.slice(bIdx)).not.toContain('31m');
  });

  it('a default (uncoloured) row emits no colour sequences', () => {
    const g = new VtGrid(4, 1);
    g.write('ok');
    expect(g.renderRows()[0]).not.toContain('31m');
  });
});

describe('VtGrid — line wrap', () => {
  it('writing more than cols chars wraps to the next row', () => {
    const g = new VtGrid(5, 3);
    g.write('123456');
    const rows = g.renderPlainRows();
    expect(rows[0]).toBe('12345');
    expect(rows[1]).toBe('6    ');
    expect(g.cursorX).toBe(1);
    expect(g.cursorY).toBe(1);
  });
});

describe('VtGrid — scroll', () => {
  it('scrolls so the last lines remain and the earliest scroll off', () => {
    const g = new VtGrid(3, 3);
    g.write('1\r\n2\r\n3\r\n4\r\n5');
    const rows = g.renderPlainRows().map(trim);
    expect(rows).toEqual(['3', '4', '5']);
  });
});

describe('VtGrid — resize', () => {
  it('preserves top-left content and clamps the cursor', () => {
    const g = new VtGrid(5, 3);
    g.write('HELLO'); // fills row 0, cursorX -> 5
    expect(g.cursorX).toBe(5);
    g.resize(3, 2);
    const rows = g.renderPlainRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toBe('HEL'); // top-left kept, each row exactly new cols wide
    expect(rows[0]!.length).toBe(3);
    expect(g.cursorX).toBe(2); // clamped to cols-1
    expect(g.cursorY).toBe(0);
  });

  it('growing keeps existing content and blanks the rest', () => {
    const g = new VtGrid(3, 2);
    g.write('ab\r\ncd');
    g.resize(5, 3);
    const rows = g.renderPlainRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe('ab   ');
    expect(rows[1]).toBe('cd   ');
    expect(trim(rows[2]!)).toBe('');
  });
});

describe('VtGrid — escape split across writes', () => {
  it('carries a partial escape via the pending buffer', () => {
    const g = new VtGrid(6, 1);
    g.write('\x1b[');
    g.write('31mX');
    const row = g.renderRows()[0]!;
    expect(row).toContain('\x1b[31m');
    expect(g.renderPlainRows()[0]![0]).toBe('X');
    expect(g.cursorX).toBe(1);
  });

  it('carries a lone ESC across writes', () => {
    const g = new VtGrid(6, 1);
    g.write('A\x1b');
    g.write('[1;1HB'); // ESC[1;1H home then B
    expect(g.renderPlainRows()[0]![0]).toBe('B');
  });
});

describe('VtGrid — OSC ignored', () => {
  it('consumes an OSC title (BEL-terminated) without corrupting output', () => {
    const g = new VtGrid(10, 1);
    g.write('\x1b]0;my title\x07ABC');
    expect(trim(g.renderPlainRows()[0]!)).toBe('ABC');
    expect(g.cursorX).toBe(3);
  });

  it('consumes an OSC terminated by ST (ESC backslash)', () => {
    const g = new VtGrid(10, 1);
    g.write('\x1b]0;t\x1b\\XY');
    expect(trim(g.renderPlainRows()[0]!)).toBe('XY');
  });
});
