#!/usr/bin/env node
// Tiny full-screen (alt-screen) helper for the terminal-fidelity e2e.
//
// Enters the DEC alternate screen buffer (\x1b[?1049h), clears it, and then on a
// timer repaints a UNIQUE, ever-incrementing marker at the home position WITHOUT
// ever leaving the alt buffer. This mimics a real full-screen app (vim/htop) that
// is mid-session: its current frame lives only in the emulator, so a correct
// window-switch repaint must reproduce `\x1b[?1049h` + the latest `ALT-FRAME-N`.
//
// On SIGINT (Ctrl-C) it leaves the alt buffer (\x1b[?1049l) and exits, which is
// what lets bug 2 observe the host repaint the restored primary screen.
const out = process.stdout;
out.write('\x1b[?1049h\x1b[2J\x1b[H');
let n = 0;
const paint = () => { out.write('\x1b[H' + 'ALT-FRAME-' + (++n)); };
paint();
const timer = setInterval(paint, 100);
const quit = () => {
  clearInterval(timer);
  out.write('\x1b[?1049l');
  process.exit(0);
};
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
// Keep the process alive.
setInterval(() => {}, 1 << 30);
