// How the second-round boards were first written (2026-11-16). It writes into ./out/project, never into ../project:
// the .dc.html files in ../project are the source of truth, and a board edited by hand since must not be rebuilt.
// Boards new in round two are built from lib.mjs; boards of the first draft are read from ../published-v9 and
// changed only where the structure changed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  I, acc, backHeader, bar, bookRows, books as B, btn, c, cover, desktop, dot, group, lead, page, phone, rail, row, rows,
  sans, segments, sheet, square, st, stackCover, step, svg, tabBar, tip, toggle, topHeader,
} from './lib.mjs';
import { T, tipGroups } from './tips.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.SONDER_DESIGN_SRC ?? join(here, '..', 'published-v9', 'project');
const OUT = join(here, 'out', 'project');
mkdirSync(OUT, { recursive: true });

/** name -> its canvas.json entry (without the frame position, which the layout below adds). */
const boards = {};
function add(name, title, w, h, root, { fonts, ...extra } = {}) {
  boards[name] = { w, h, title, ...extra };
  writeFileSync(join(OUT, name), page(title, w, h, root, fonts));
}
const stack = (...parts) => parts.filter(Boolean).join('\n\n');
const check = svg(I.check, 20, { stroke: acc, sw: 2.5, label: 'Selected' });
const okTick = svg(I.check, 20, { stroke: c.ok, sw: 2.5 });
const hint = (text, color = c.muted) => `<span style="font-size: 12px; line-height: 16px; font-weight: 600; color: ${color}; white-space: nowrap">${text}</span>`;
const two = (a, b) => `<div style="flex: none; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px">
${a}
${b}
</div>`;
const note = (text, o = {}) => `<p style="${st.note}; flex: none; padding: 0 16px${o.center ? '; text-align: center' : ''}">${text}</p>`;

// ---------------------------------------------------------------- Book

const bookHeader = (favorite) => `<header style="height: 44px; flex: none; display: flex; align-items: center; justify-content: space-between">
${square(svg(I.back), 'Back to Library', { href: 'Library.dc.html' })}
${square(svg(I.heart, 20, favorite ? { fill: 'currentColor' } : {}), 'Favorite', { pressed: favorite, color: favorite ? acc : c.text })}
</header>`;

const seriesLink = (text) => `<a href="Series.dc.html" style="align-self: flex-start; min-height: 44px; margin: -12px 0; color: ${c.text}; font-size: 14px; line-height: 20px; font-weight: 500; text-decoration: none; display: flex; align-items: center; gap: 4px">${text}${svg(I.chev, 16, { stroke: c.muted })}</a>`;
const bookIntro = (b, state, series = '') => `<div style="flex: none; display: flex; gap: 16px; align-items: flex-end">
<div style="width: 96px; height: 96px; flex: none; border-radius: 8px; background: ${b.col}; padding: 12px; box-sizing: border-box; font-family: 'Manrope', sans-serif; font-weight: 700; font-size: 13px; line-height: 16px">${b.ct ?? b.t}</div>
<div style="min-width: 0; display: flex; flex-direction: column; gap: 4px">
<h1 style="${st.heading}">${b.t}</h1>
<div style="${st.sub}">${b.a}</div>${series ? `\n${seriesLink(series)}` : ''}
<div style="${st.sub}">${state}</div>
</div>
</div>`;

const playIcon = svg(I.play, 18, { fill: 'currentColor' });
const bookActions = (off) =>
  two(
    off ? btn('secondary', 'Listen', { off: true, icon: playIcon }) : btn('primary', 'Listen', { href: 'NowPlaying.dc.html', icon: playIcon }),
    btn('secondary', 'Read', { off, icon: svg(I.ebook, 18) }),
  );

// The description, collapsed to three lines; a tap opens it.
const about = `<div style="flex: none; display: flex; flex-direction: column; gap: 8px">
<h2 style="${st.caption}; padding: 0 16px">About</h2>
<button type="button" aria-expanded="false" aria-label="Show the whole description" style="border: 0; border-radius: 14px; background: ${c.surface}; padding: 16px; display: flex; align-items: flex-start; gap: 12px; text-align: left; color: ${c.muted}; font: 400 14px/20px 'DM Sans', sans-serif"><span style="flex: 1; height: 60px; overflow: hidden">[DESCRIPTION]</span>${svg(I.down, 20, { stroke: c.muted })}</button>
</div>`;
const bookEnd = group('', rows([
  { btn: true, label: 'Hardcover', value: 'Currently reading', chev: true },
  { btn: true, label: 'Mark as finished' },
  { btn: true, label: 'Remove from library', danger: true },
]));

add('Book.dc.html', 'Book', 390, 844, phone(stack(
  bookHeader(true),
  bookIntro(B.anti, 'Chapter 7 · 12 min left'),
  bookActions(false),
  group('Files', rows([
    { href: 'Audiobook.dc.html', lead: lead(I.audio), label: 'Audiobook', sub: '[NARRATOR] · 9 h 12 min · On server', chev: true },
    { href: 'Ebook.dc.html', lead: lead(I.ebook), label: 'Ebook', sub: 'EPUB · 1.2 MB · On server', chev: true },
    { href: 'ReadingSyncReady.dc.html', lead: lead(I.sync), label: 'Reading sync', tip: T.readingSync, sub: 'Ready · estimated timings', chev: true },
  ])),
  group('This device', rows([
    { label: 'Keep on this device', tip: T.keep, tipOpen: true, sub: 'Audiobook and ebook · 414 MB', right: toggle(true, 'Keep on this device') },
  ])),
  about,
), 'library'));

// The same page further down: what follows the files.
add('BookMore.dc.html', 'Book: further down', 390, 844, phone(stack(
  bookHeader(true),
  group('This device', rows([
    { label: 'Keep on this device', tip: T.keep, sub: 'Audiobook and ebook · 414 MB', right: toggle(true, 'Keep on this device') },
  ])),
  about,
  bookEnd,
), 'library'));

add('BookGetting.dc.html', 'Book: files on their way', 390, 844, phone(stack(
  bookHeader(false),
  bookIntro(B.snow, 'Not started'),
  bookActions(true),
  group('Files', rows([
    { href: 'Activity.dc.html', lead: lead(I.audio), label: 'Audiobook', sub: 'Downloading to server · 43%', below: bar(43), chev: true },
    { lead: lead(I.ebook), label: 'Ebook', sub: 'Not added', right: btn('secondary', 'Get', { href: 'GetEbook.dc.html', aria: 'Get an ebook' }) },
    { lead: lead(I.sync), label: 'Reading sync', tip: T.readingSync, sub: 'Needs an ebook', dim: true },
  ])),
  group('This device', rows([
    { label: 'Keep on this device', tip: T.keep, right: toggle(false, 'Keep on this device') },
  ])),
  about,
), 'library'));

// ---------------------------------------------------------------- Audiobook and Ebook

add('Audiobook.dc.html', 'Audiobook', 390, 844, phone(stack(
  backHeader('Book.dc.html', 'Back to the book', 'Audiobook', B.anti.t),
  group('Recordings', rows([
    { btn: true, pressed: true, sel: true, label: '[NARRATOR]', sub: 'English · 9 h 12 min · M4B', right: check },
    { btn: true, pressed: false, label: '[NARRATOR 2]', sub: 'English · 9 h 40 min · MP3' },
    { href: 'GetAudiobook.dc.html', label: 'Get another recording', chev: true },
  ]), { tip: T.recordings }),
  group('Available from', rows([
    { btn: true, label: 'Device copy', value: '412 MB', chev: true },
    { btn: true, label: 'Server copy', value: '412 MB', chev: true },
    { btn: true, label: 'Original stream', value: 'TorBox', chev: true },
  ]), { tip: T.audioFrom }),
  group('', rows([
    { btn: true, label: 'Plays from', tip: T.playsFrom, value: 'Automatic', chev: true },
    { btn: true, label: 'Report a problem', tip: T.problem, chev: true },
  ])),
), 'library'));

add('Ebook.dc.html', 'Ebook', 390, 844, phone(stack(
  backHeader('Book.dc.html', 'Back to the book', 'Ebook', B.anti.t),
  group('Editions', rows([
    { btn: true, pressed: true, sel: true, label: 'EPUB · 1.2 MB', sub: 'Matches the narration', right: check },
    { btn: true, pressed: false, label: 'EPUB · 0.9 MB', sub: 'Checking against the narration' },
    { btn: true, label: 'PDF · 4.1 MB', sub: 'Opens in another app', chev: true },
    { href: 'GetEbook.dc.html', label: 'Get another edition', chev: true },
    { btn: true, label: 'Import a file', chev: true },
  ]), { tip: T.editions }),
  group('Available from', rows([
    { btn: true, label: 'Device copy', value: '1.2 MB', chev: true },
    { btn: true, label: 'Server copy', value: '1.2 MB', chev: true },
  ]), { tip: T.ebookFrom }),
  group('', rows([{ btn: true, label: 'Export the file', tip: T.exportFile, chev: true }])),
), 'library'));

// ---------------------------------------------------------------- Get a recording or an edition

const sheetHeader = (closeHref, title) => `<header style="height: 44px; flex: none; display: flex; align-items: center; justify-content: space-between">
${square(svg(I.close), 'Close', { href: closeHref })}
<span style="${st.caption}">${title}</span>
<span style="width: 44px; height: 44px; flex: none; display: block"></span>
</header>`;

const sheetBook = (b) => `<div style="flex: none; display: flex; align-items: center; gap: 12px">
${cover(b, 56)}
<div style="min-width: 0; display: flex; flex-direction: column; gap: 2px">
<h1 style="${st.heading}">${b.t}</h1>
<div style="${st.sub}">${b.a}</div>
</div>
</div>`;

const searchField = (label, value) =>
  `<label style="height: 44px; flex: 1; min-width: 0; box-sizing: border-box; padding: 0 12px; border-radius: 8px; background: ${c.raised}; color: ${c.muted}; display: flex; align-items: center; gap: 8px">${svg(I.search, 18)}<input type="search" aria-label="${label}" value="${value}" style="flex: 1; min-width: 0; border: 0; background: transparent; color: ${c.text}; font: 400 16px/22px ${sans}; outline-offset: 4px"></label>`;

const sheetEnd = (action, href, text) => `<div style="margin-top: auto; flex: none; display: flex; flex-direction: column; gap: 8px">
${btn('primary', action, { href, full: true })}
${note(text, { center: true })}
</div>`;

add('GetAudiobook.dc.html', 'Get audiobook', 390, 844, sheet(stack(
  sheetHeader('Library.dc.html', 'Get audiobook'),
  sheetBook(B.frank),
  `<div style="flex: none; display: flex; gap: 8px">
${searchField('Search for a recording', 'Frankenstein Mary Shelley')}
<button type="button" aria-label="Language: English" style="height: 44px; flex: none; padding: 0 12px; border: 0; border-radius: 8px; background: ${c.raised}; color: ${c.text}; font: 500 14px/20px ${sans}; display: flex; align-items: center; gap: 4px">English${svg(I.down, 16, { stroke: c.muted })}</button>
</div>`,
  group('Recordings · 4', rows([
    { btn: true, pressed: true, sel: true, label: '[NARRATOR]', sub: 'M4B · 64 kbps · 602 MB', right: hint('Plays now', c.ok) + check },
    { btn: true, pressed: false, label: '[NARRATOR]', sub: 'MP3 · 128 kbps · 1.1 GB', right: hint('24 seeders') },
    { btn: true, pressed: false, label: '[NARRATOR 2]', sub: 'MP3 · 64 kbps · 480 MB', right: hint('3 seeders') },
    { btn: true, pressed: false, label: '[NARRATOR 3]', sub: 'M4B · 96 kbps · 890 MB', right: hint('No seeders') },
  ]), { note: 'From AudioBookBay and Prowlarr.', tip: T.getRecordings }),
  group('', rows([
    { btn: true, label: 'Paste a magnet link', chev: true },
    { btn: true, label: 'Import files from this device', chev: true },
  ])),
  sheetEnd('Get this recording', 'Activity.dc.html', 'Plays from TorBox right away.'),
)));

add('GetEbook.dc.html', 'Get ebook', 390, 844, sheet(stack(
  sheetHeader('BookGetting.dc.html', 'Get ebook'),
  sheetBook(B.snow),
  `<div style="flex: none; display: flex; gap: 8px">
${searchField('Search for an edition', 'Snow Crash Neal Stephenson')}
</div>`,
  group('Editions · 4', rows([
    { btn: true, pressed: true, sel: true, label: 'Snow Crash', sub: 'EPUB · 1.2 MB · English · 2003', right: check },
    { btn: true, pressed: false, label: 'Snow Crash', sub: 'EPUB · 0.9 MB · English · 2008' },
    { btn: true, pressed: false, label: 'Snow Crash', sub: 'EPUB · 2.3 MB · Spanish · 2010' },
    { btn: true, pressed: false, label: 'Snow Crash', sub: 'PDF · 4.1 MB · English · 2000' },
  ]), { note: 'From Library Genesis.', tip: T.getEditions }),
  group('', rows([
    { btn: true, label: 'Import a file from this device', chev: true },
    { btn: true, label: 'Search on Library Genesis', right: svg(I.external, 16, { stroke: c.muted }) },
  ])),
  sheetEnd('Get this edition', 'BookGetting.dc.html', 'Saved on the server, then checked against the narration.'),
)));

// ---------------------------------------------------------------- Reading sync

const pair = (recording, edition) => group('', rows([
  { href: 'Audiobook.dc.html', label: 'Recording', value: recording, chev: true },
  { href: 'Ebook.dc.html', label: 'Edition', value: edition, chev: true },
]));
const steps = (list) => `<div style="padding: 4px 0">\n${list.join('\n')}\n</div>`;
const details = { btn: true, label: 'Details', value: 'Engine, GPU, stage times', chev: true };

const preparing = (side) => stack(
  group('Preparing', steps([
    step('done', 'Waiting for a worker'),
    step('done', 'Copying audio'),
    step('done', 'Decoding audio', '43 of 43 files'),
    step('now', 'Encoding audio', '24 of 43 files', 56),
    step('next', 'Anchoring text to audio'),
    step('next', 'Aligning text'),
    step('next', 'Saving the map'),
  ]), { side, tip: T.preparing }),
  two(btn('secondary', 'Pause'), btn('secondary', 'Cancel')),
  note('Pause stops the worker. Resume starts this book over.'),
  group('', rows([details])),
);

add('ReadingSync.dc.html', 'Reading sync: preparing', 390, 844, phone(stack(
  backHeader('Activity.dc.html', 'Back to Activity', 'Reading sync', B.feral.t, { tip: T.syncTitle }),
  pair('[NARRATOR]', 'EPUB · 1.6 MB'),
  preparing('On wsl · GPU · 12 min'),
), 'activity'));

add('ReadingSyncReady.dc.html', 'Reading sync: ready', 390, 844, phone(stack(
  backHeader('Book.dc.html', 'Back to the book', 'Reading sync', B.anti.t, { tip: T.syncTitle }),
  pair('[NARRATOR]', 'EPUB · 1.2 MB'),
  group('Status', rows([
    { label: 'Ready', tip: T.ready, sub: 'Timings are estimated', right: okTick },
    { label: 'Text mapped', tip: T.mapped, below: bar(96), value: '96%', valueColor: c.text },
  ]), { side: 'Today 14:02 · 38 min on wsl' }),
  group('Unsynced passages · 2', rows([
    { label: 'Title page', sub: '[EXCERPT] · 6 sentences' },
    { label: 'Acknowledgements', sub: '[EXCERPT] · 14 sentences' },
  ]), { tip: T.unsynced }),
  group('', rows([{ btn: true, label: 'Prepare again', tip: T.prepareAgain }, details])),
), 'library'));

const attention = `<span style="width: 20px; height: 20px; flex: none; display: flex; align-items: center; justify-content: center">${dot('Needs attention')}</span>`;

add('ReadingSyncStopped.dc.html', 'Reading sync: stopped', 390, 844, phone(stack(
  backHeader('Activity.dc.html', 'Back to Activity', 'Reading sync', B.matter.t, { tip: T.syncTitle }),
  pair('[NARRATOR]', 'EPUB · 0.8 MB'),
  group('Stopped', rows([
    { lead: attention, label: 'Stopped while encoding audio', sub: 'Reading sync failed on every worker.' },
    { label: 'wsl', sub: 'Did not answer for [N] minutes' },
    { label: 'lisa', sub: '[REASON FROM THE WORKER]' },
  ]), { tip: T.stopped }),
  btn('primary', 'Resume', { full: true }),
  note('Resume starts this book over on the first free worker.'),
  group('', rows([
    { href: 'ActivityServer.dc.html', label: 'Workers', value: '1 of 2 online', chev: true },
    details,
  ])),
), 'activity'));

// ---------------------------------------------------------------- Activity

const sections = [['Now', 'Activity.dc.html'], ['This device', 'ActivityDevice.dc.html'], ['Server', 'ActivityServer.dc.html']];
const activityTop = (current) => stack(topHeader('Activity'), segments('Activity sections', sections, current));

const nowGroups = (selected) => stack(
  group('Needs attention', bookRows([
    { book: B.matter, href: 'ReadingSyncStopped.dc.html', lines: [{ icon: I.sync, what: 'Reading sync', text: 'Reading sync stopped', danger: true }], action: btn('secondary', 'Resume', { tight: true }) },
  ]), { tip: T.attention }),
  group('In progress', bookRows([
    { book: B.snow, href: 'BookGetting.dc.html', lines: [{ icon: I.audio, what: 'Audiobook', text: 'Downloading to server · 43%', bar: 43 }], chev: true },
    { book: B.feral, href: 'ReadingSync.dc.html', sel: selected, lines: [{ icon: I.sync, what: 'Reading sync', text: 'Encoding audio · 24 of 43 files', bar: 56 }], chev: true },
  ]), { tip: T.progress }),
  group('Waiting', bookRows([
    { book: B.dorian, href: 'Activity.dc.html', lines: [{ icon: I.sync, what: 'Reading sync', text: 'Waiting for a worker' }], chev: true },
  ]), { tip: T.waiting }),
  group('Finished today', bookRows([
    { book: B.anti, href: 'Book.dc.html', lines: [{ icon: I.sync, what: 'Reading sync', text: 'Reading sync ready' }], value: '2 h ago' },
    { book: B.frank, href: 'Library.dc.html', lines: [{ icon: I.ebook, what: 'Ebook', text: 'Ebook on server' }], value: '5 h ago' },
  ]), { tip: T.finished }),
);

add('Activity.dc.html', 'Activity: now', 390, 844, phone(stack(activityTop(0), nowGroups(false)), 'activity'));

add('ActivityDevice.dc.html', 'Activity: this device', 390, 844, phone(stack(
  activityTop(1),
  group('Storage', rows([
    { label: 'Used by Sonder', tip: T.used, below: bar(18), value: '2.1 GB of 12 GB' },
    { label: 'Protected storage', tip: T.protectedStorage, value: 'On' },
  ])),
  group('Saving now', bookRows([
    { book: B.matter, href: 'Activity.dc.html', lines: [{ icon: I.audio, what: 'Audiobook', text: 'Saving · 3 of 12 files', bar: 25 }], action: btn('secondary', 'Pause', { tight: true }) },
  ]), { note: 'Keep Sonder open while saving.' }),
  group('Kept on this device', bookRows([
    { book: B.anti, href: 'Book.dc.html', lines: [{ text: 'Audiobook and ebook · 414 MB' }], action: square(svg(I.trash), 'Remove There Is No Antimemetics Division from this device', { quiet: true }) },
    { book: B.frank, href: 'Library.dc.html', lines: [{ text: 'Ebook · 0.6 MB' }], action: square(svg(I.trash), 'Remove Frankenstein from this device', { quiet: true }) },
  ]), { tip: T.kept }),
), 'activity'));

const syncQueue = group('Reading sync', rows([
  { label: 'Reading sync queue', tip: T.syncQueue, sub: '1 preparing · 1 waiting', right: toggle(true, 'Start new reading sync work') },
  { btn: true, label: 'Prepare for all books', tip: T.prepareAll, value: '34 ready', chev: true },
]));
const workers = (selected) => group('Workers', rows([
  { href: 'Worker.dc.html', sel: selected, label: 'wsl', sub: 'Online · GPU · Encoding: Feral Gods', chev: true },
  { btn: true, label: 'lisa', sub: 'Offline since 14:02', subColor: c.danger, right: dot('Needs attention'), chev: true },
]), { tip: T.workers });
const downloads = (all) => group('Downloads', rows([
  { label: 'Download queue', tip: T.downloadQueue, sub: '1 downloading', right: toggle(true, 'Check and import downloads') },
  { label: 'Torrent client', tip: T.torrent, sub: 'Running' },
  { label: 'Copies to server', tip: T.copies, sub: 'Nothing running', right: toggle(true, 'Start new copies to the server') },
  ...(all ? [{ label: 'Series search', tip: T.seriesSearch, sub: 'Paused', right: toggle(false, 'Start new series searches') }] : []),
]));
const other = group('Other', rows([
  { label: 'Ebook checks', tip: T.ebookChecks, sub: '1 checking', right: toggle(true, 'Start new ebook checks') },
  { label: 'Hardcover sync', tip: T.hardcoverSync, tipOpen: true, sub: '2 changes waiting · [USERNAME]', right: toggle(true, 'Send changes to Hardcover') },
  { label: 'Database backups', tip: T.backups, sub: 'Last: today 03:00 UTC · 48 MB', right: toggle(true, 'Run daily database backups') },
  { label: 'Imports', tip: T.imports, sub: 'Not tracked yet', dim: true },
]));

add('ActivityServer.dc.html', 'Activity: server', 390, 844, phone(stack(activityTop(2), syncQueue, workers(false), downloads(false)), 'activity'));

const workerDetail = (open) => stack(
  group('Status', rows([
    { label: 'Status', value: 'Online', valueColor: c.text },
    { label: 'Device', value: 'GPU' },
    { label: 'Now', value: 'Encoding: Feral Gods' },
    { label: 'Code version', tip: T.codeVersion, value: '[REVISION]' },
  ])),
  group('', rows([{ label: 'Use this worker', tip: T.useWorker, tipOpen: open, right: toggle(true, 'Use this worker') }])),
  group('', rows([{ label: 'Restart', tip: T.restart, sub: 'Last: today 09:12 · ready again', wrap: true, right: btn('secondary', 'Restart', { aria: 'Restart wsl' }) }])),
);

add('Worker.dc.html', 'Worker', 390, 844, phone(stack(
  backHeader('ActivityServer.dc.html', 'Back to Activity', 'wsl', 'Reading sync worker'),
  workerDetail(true),
), 'activity'));

// ---------------------------------------------------------------- Desktop: Activity

const source = (name) => readFileSync(join(SRC, name), 'utf8');
/** The text from `start` up to (not including) `end`; both must occur exactly once. */
function cut(html, start, end) {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a);
  if (a < 0 || b < 0 || html.indexOf(start, a + 1) >= 0) throw new Error(`Cannot find one "${start.slice(0, 40)}" ... "${end.slice(0, 40)}"`);
  return { a, b, text: html.slice(a, b) };
}
const desktopLibrary = source('DesktopLibrary.dc.html');
const nowPlayingBar = cut(desktopLibrary, '<section aria-label="Now playing"', '\n</main>').text;

const desktopTop = (current) => `<header style="display: flex; flex-wrap: wrap; align-items: center; gap: 16px">
<h1 style="${st.title}; margin-right: auto">Activity</h1>
<div style="flex: 1 1 320px; max-width: 420px; min-width: 0; display: flex; flex-direction: column">
${segments('Activity sections', [['Now', 'DesktopActivity.dc.html'], ['This device', 'DesktopActivity.dc.html'], ['Server', 'DesktopActivityServer.dc.html']], current)}
</div>
</header>`;
const columns = (...cols) => `<div style="display: flex; flex-wrap: wrap; align-items: flex-start; gap: 32px">
${cols.join('\n')}
</div>`;
const column = (flex, body) => `<div style="flex: ${flex}; min-width: 0; display: flex; flex-direction: column; gap: 16px">
${body}
</div>`;
const detailTitle = (title, context) => `<div style="display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px">
<h2 style="${st.heading}">${title}</h2>
<span style="${st.sub}">${context}</span>
</div>`;

add('DesktopActivity.dc.html', 'Desktop: Activity', 1280, 880, desktop('activity', stack(
  desktopTop(0),
  columns(
    column('1 1 340px', nowGroups(true)),
    column('1 1 400px', stack(detailTitle('Reading sync', 'Feral Gods'), pair('[NARRATOR]', 'EPUB · 1.6 MB'), preparing('On wsl · GPU · 12 min'))),
  ),
  nowPlayingBar,
), 880), { expand: 'fill' });

add('DesktopActivityServer.dc.html', 'Desktop: Activity, server', 1280, 880, desktop('activity', stack(
  desktopTop(2),
  columns(
    column('1 1 280px', stack(syncQueue, workers(true))),
    column('1 1 280px', stack(downloads(true), other)),
    column('1 1 280px', stack(detailTitle('wsl', 'Reading sync worker'), workerDetail(false))),
  ),
  nowPlayingBar,
), 880), { expand: 'fill' });

// ---------------------------------------------------------------- Language: files and processes

const term = (name, text) => `<div><div style="${st.label}">${name}</div><div style="font-size: 12px; line-height: 16px; color: ${c.muted}">${text}</div></div>`;
const sample = (inner) => `<div style="border-radius: 14px; background: ${c.surface}; overflow: hidden">\n${inner}\n</div>`;
const words = (title, list) => `<div style="display: flex; flex-direction: column; gap: 8px">
<h3 style="${st.note}; font-weight: 500">${title}</h3>
<div style="border-radius: 14px; background: ${c.surface}; padding: 12px 16px; display: flex; flex-direction: column">
${list.map(([text, color]) => `<span style="font-size: 14px; line-height: 20px; color: ${color ?? c.text}">${text}</span>`).join('\n')}
</div>
</div>`;
const langColumn = (title, body, gap = 12) => `<div style="display: flex; flex-direction: column; gap: ${gap}px">
<h2 style="${st.caption}">${title}</h2>
${body}
</div>`;
const langNote = (text) => `<p style="${st.note}">${text}</p>`;

add('LanguageFiles.dc.html', 'Design language: files and processes', 1280, 1000, `<div style="width: 1280px; height: 1000px; box-sizing: border-box; padding: 48px; background: ${c.ground}; color: ${c.text}; font-family: 'DM Sans', system-ui, sans-serif; display: flex; flex-direction: column; gap: 32px">
<div style="display: flex; align-items: baseline; justify-content: space-between; gap: 24px">
<h1 style="${st.title}">Files and processes</h1>
<p style="margin: 0; ${st.sub}">One row for a file, one list for work in progress, one set of words for both.</p>
</div>

<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 32px">

<div style="display: flex; flex-direction: column; gap: 24px">
${langColumn('Words', stack(
    term('Server', 'Replaces HDD, 4 TB media drive, home server and Host server.'),
    term('This device', 'Replaces device cache, offline and saved here.'),
    term('Recording', 'One narration of a book. Replaces version and release.'),
    term('Edition', 'One EPUB or PDF of a book.'),
    term('Reading sync', 'The ebook following the narration. Replaces alignment in Activity.'),
    term('Get', 'Find a recording or an edition and add it. Replaces Find another release and Find ebook.'),
    term('Keep on this device', 'Replaces Save offline, Save on device and Save ebook offline.'),
  ).replaceAll('\n\n', '\n'))}
${langColumn('Where they live', stack(
    term('Book, Files', 'Audiobook, Ebook and Reading sync, in that order. Replaces Versions &amp; sources, the release picker and the reader&#39;s Reading sync panel.'),
    term('Get', 'One sheet for a recording or an edition. Replaces the release dialog and the ebook search in Discover.'),
    term('Activity, Now', 'Books with work in progress. Replaces the Downloads queue and the Activity item list.'),
    term('Activity, This device', 'What is kept here. Replaces Downloads, On this device.'),
    term('Activity, Server', 'Queues and workers. Replaces Settings, Reading sync and the process list.'),
  ).replaceAll('\n\n', '\n'))}
</div>

${langColumn('Status lines', stack(
    words('An audiobook or an ebook', [['Not added'], ['Finding a source'], ['Downloading to server · 43%'], ['Paused · 43%'], ['On server'], ['Download failed', c.danger]]),
    words('An ebook against the narration', [['Checking against the narration'], ['Matches the narration'], ['Does not match the narration'], ['Waiting for the audiobook'], ['Waiting for a worker']]),
    words('Reading sync', [['Needs an ebook'], ['Waiting for a worker'], ['Encoding audio · 24 of 43 files'], ['Ready · estimated timings'], ['Partly ready · 61% of the text'], ['Stopped', c.danger]]),
    words('This device', [['Saving · 3 of 12 files'], ['On this device · 414 MB'], ['Not complete · 8 of 12 files', c.danger]]),
    words('A queue or a worker', [['1 preparing · 1 waiting'], ['Paused'], ['Online · GPU'], ['Not in use'], ['Offline since 14:02', c.danger]]),
  ).replaceAll('\n\n', '\n'), 16)}

${langColumn('Rows', stack(
    sample(rows([
      { lead: lead(I.audio), label: 'Audiobook', sub: 'Downloading to server · 43%', below: bar(43), chev: true },
      { lead: lead(I.ebook), label: 'Ebook', sub: 'Not added', right: btn('secondary', 'Get', { aria: 'Get an ebook' }) },
    ])),
    langNote('File row: icon, name, one status line, 64 high. A bar while it moves.'),
    sample(bookRows([
      { book: B.feral, href: 'ReadingSync.dc.html', lines: [{ icon: I.sync, what: 'Reading sync', text: 'Encoding audio · 24 of 43 files', bar: 56 }], chev: true },
    ])),
    langNote('Book row: cover, title, the same status line. Used in Activity.'),
    sample(rows([
      { btn: true, pressed: true, sel: true, label: '[NARRATOR]', sub: 'English · 9 h 12 min · M4B', right: check },
      { btn: true, pressed: false, label: '[NARRATOR 2]', sub: 'English · 9 h 40 min · MP3' },
    ])),
    langNote('Choice row: two lines, raised when chosen, tick on the right edge.'),
    sample(steps([
      step('done', 'Decoding audio', '43 of 43 files'),
      step('now', 'Encoding audio', '24 of 43 files', 56),
      step('next', 'Aligning text'),
    ])),
    langNote('Steps: done, running, not started. 36 high, no dividers.'),
  ).replaceAll('\n\n', '\n'))}

</div>
</div>`);

// ---------------------------------------------------------------- Series

const both = [[I.audio, 'Audiobook'], [I.ebook, 'Ebook']];
const audioOnly = [[I.audio, 'Audiobook']];
const culture = { name: 'The Culture', author: 'Iain M. Banks', covers: [B.matter.col, '#3a4f5d', '#4f5d3a'] };
const member = (num, title, col) => ({ num, compact: true, book: { t: title, col } });
const playNext = `<a href="NowPlaying.dc.html" aria-label="Listen to Matter" style="width: 44px; height: 44px; flex: none; border-radius: 999px; background: ${acc}; color: ${c.ground}; display: flex; align-items: center; justify-content: center">${svg(I.play, 20, { fill: 'currentColor' })}</a>`;
const missing = (num, title, col) => ({
  ...member(num, title, col),
  lines: [{ text: 'Not in your library' }],
  action: btn('secondary', 'Add', { tight: true, href: 'SeriesAdd.dc.html', aria: `Add ${title}` }),
});
const seriesBooks = group('Books · 10', bookRows([
  { ...member(1, 'Consider Phlebas', '#4f5d3a'), href: 'Book.dc.html', lines: [{ icons: both, text: 'Finished' }], chev: true },
  { ...member(2, 'The Player of Games', '#5d4a3a'), href: 'Book.dc.html', lines: [{ icons: both, text: 'Finished' }], chev: true },
  { ...member(3, 'Use of Weapons', '#3a4f5d'), href: 'Book.dc.html', lines: [{ icons: audioOnly, text: 'Finished' }], chev: true },
  missing(4, 'The State of the Art', '#5a5a3a'),
  missing(5, 'Excession', '#3f3a5d'),
  missing(6, 'Inversions', '#5d3a4a'),
  { ...member(7, 'Look to Windward', '#3a5d55'), href: 'Book.dc.html', lines: [{ icons: both, text: 'Not started' }], chev: true },
  { ...member(8, 'Matter', B.matter.col), href: 'BookSeries.dc.html', sel: true, lines: [{ icons: both, text: 'Chapter 3 · 5 h left' }], action: playNext },
  { ...member(9, 'Surface Detail', '#4a3a5d'), href: 'Activity.dc.html', lines: [{ icons: audioOnly, text: 'Finding a source' }], chev: true },
  missing(10, 'The Hydrogen Sonata', '#5d553a'),
]), { tip: T.seriesBooks });
const seriesProgress = `${culture.author} · 3 of 10 finished`;

/** The saved series, each opening its page. */
const seriesRows = (selected) => bookRows([
  { book: { t: culture.name }, cover: stackCover(culture.covers), href: 'Series.dc.html', sel: selected, lines: [{ text: seriesProgress }], chev: true },
  { book: { t: 'Remembrance of Earth’s Past' }, cover: stackCover(['#5d3a3a', '#3a3a5d', '#5d553a']), href: 'Series.dc.html', lines: [{ text: 'Liu Cixin · 1 of 3 finished' }], chev: true },
  { book: { t: 'Earthsea' }, cover: stackCover(['#3a5d55', '#55503a', '#3f4a5d']), href: 'Series.dc.html', lines: [{ text: 'Ursula K. Le Guin · 0 of 6 finished' }], chev: true },
]);

add('BookSeries.dc.html', 'Book: in a series', 390, 844, phone(stack(
  bookHeader(false),
  bookIntro(B.matter, 'Chapter 3 · 5 h left', 'The Culture · Book 8'),
  bookActions(false),
  group('Files', rows([
    { href: 'Audiobook.dc.html', lead: lead(I.audio), label: 'Audiobook', sub: '[NARRATOR] · 17 h 54 min · On server', chev: true },
    { href: 'Ebook.dc.html', lead: lead(I.ebook), label: 'Ebook', sub: 'EPUB · 0.8 MB · On server', chev: true },
    { href: 'ReadingSyncStopped.dc.html', lead: lead(I.sync), label: 'Reading sync', tip: T.readingSync, sub: 'Stopped', subColor: c.danger, right: dot('Needs attention'), chev: true },
  ])),
  group('This device', rows([
    { label: 'Keep on this device', tip: T.keep, sub: 'Saving · 3 of 12 files', below: bar(25), right: toggle(true, 'Keep on this device') },
  ])),
  about,
), 'library'));

add('Series.dc.html', 'Series', 390, 844, phone(stack(
  backHeader('LibrarySeries.dc.html', 'Back to Library', culture.name, seriesProgress),
  seriesBooks,
), 'library'));

add('SeriesAdd.dc.html', 'Series: add books', 390, 844, sheet(stack(
  sheetHeader('Series.dc.html', 'Add to library'),
  `<div style="flex: none; display: flex; align-items: center; gap: 12px">
${stackCover(culture.covers)}
<div style="min-width: 0; display: flex; flex-direction: column; gap: 2px">
<h1 style="${st.heading}">${culture.name}</h1>
<div style="${st.sub}">${culture.author}</div>
</div>
</div>`,
  group('Not in your library · 4', rows([
    { btn: true, pressed: true, sel: true, label: 'The State of the Art', sub: 'Book 4', right: check },
    { btn: true, pressed: true, sel: true, label: 'Excession', sub: 'Book 5', right: check },
    { btn: true, pressed: false, label: 'Inversions', sub: 'Book 6' },
    { btn: true, pressed: true, sel: true, label: 'The Hydrogen Sonata', sub: 'Book 10', right: check },
  ])),
  group('For the books you add', rows([
    { label: 'Get the audiobooks', tip: T.seriesAudio, right: toggle(true, 'Get the audiobooks') },
    { label: 'Get the ebooks', tip: T.seriesEbooks, right: toggle(false, 'Get the ebooks') },
    { btn: true, label: 'Preferred language', value: 'English', chev: true },
  ])),
  sheetEnd('Add 3 books', 'Series.dc.html', 'What is found downloads to your server.'),
)));

// ---------------------------------------------------------------- Boards already on the canvas

/** Replaces the one occurrence of `from` (a string or a regular expression without the g flag). */
function swap(html, from, to, what) {
  const found = typeof from === 'string' ? html.split(from).length - 1 : (html.match(new RegExp(from.source, 'g')) ?? []).length;
  if (found !== 1) throw new Error(`${what}: expected one match, found ${found}`);
  return html.replace(from, () => to);
}
const NAV = /<nav aria-label="Main"[\s\S]*?<\/nav>/;
const keep = (name, title, w, h, html, extra = {}) => {
  boards[name] = { w, h, title, ...extra };
  writeFileSync(join(OUT, name), html);
};

// Library: four places, one add button for either format, what each book has on its cover, and series as a filter.
const mark = (icon, label) => svg(icon, 12, { sw: 2.5, label });
const has = { audio: mark(I.audio, 'Audiobook'), ebook: mark(I.ebook, 'Ebook'), sync: mark(I.sync, 'Reading sync ready') };
const pill = (marks) => `<span style="align-self: flex-start; height: 20px; padding: 0 6px; border-radius: 999px; background: ${c.ground}; font-family: ${sans}; font-weight: 600; font-size: 11px; line-height: 16px; display: flex; align-items: center; gap: 4px">${marks}</span>`;
const tile = (b, href, marks) => `<a href="${href}" style="display: flex; flex-direction: column; gap: 8px; color: #e6eadf; text-decoration: none"><div style="aspect-ratio: 1; border-radius: 8px; background: ${b.col}; padding: 8px; box-sizing: border-box; font-family: 'Manrope', sans-serif; font-weight: 700; font-size: 12px; line-height: 15px; display: flex; flex-direction: column; justify-content: space-between">${b.ct ?? b.t}${pill(marks)}</div><div><div style="font-size: 14px; line-height: 20px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${b.t}</div><div style="font-size: 12px; line-height: 16px; color: #a9b59d">${b.a}</div></div></a>`;
const tiles = `<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px 12px">
${tile(B.anti, 'Book.dc.html', has.audio + has.ebook + has.sync)}
${tile(B.snow, 'BookGetting.dc.html', `${has.audio}43%`)}
${tile(B.matter, 'BookSeries.dc.html', has.audio + has.ebook)}
${tile(B.dorian, 'Book.dc.html', has.audio + has.ebook)}
${tile(B.feral, 'Book.dc.html', has.audio + has.ebook)}
${tile(B.frank, 'Book.dc.html', has.ebook)}
</div>`;

/** The filter chips. The ones that have a board of their own (`links`, by position) are links. */
function chips(current, links, onPhone) {
  const names = ['All', 'Series', 'In progress', 'Not started', 'Finished', 'On device', 'Favorites'];
  const one = (text, i) => {
    const on = i === current;
    const box = `${onPhone ? 'flex: none; ' : ''}height: 44px; padding: 0 16px; border-radius: 999px; background: ${on ? '#e6eadf' : '#26331f'}; color: ${on ? '#101510' : '#e6eadf'}`;
    return links[i]
      ? `<a href="${links[i]}"${on ? ' aria-current="page"' : ''} style="${box}; font-size: 14px; line-height: 20px; font-weight: ${on ? 600 : 500}; text-decoration: none; display: flex; align-items: center">${text}</a>`
      : `<button type="button" aria-pressed="${on}" style="${box}; border: 0; font: ${on ? 600 : 500} 14px/20px 'DM Sans', sans-serif">${text}</button>`;
  };
  const lay = onPhone ? 'display: flex; gap: 8px; margin-right: -16px; overflow: hidden' : 'display: flex; flex-wrap: wrap; gap: 8px; margin-right: auto';
  return `<div role="group" aria-label="Filter your library" style="${lay}">\n${names.map(one).join('\n')}\n</div>`;
}
const CHIPS = '<div role="group" aria-label="Filter your library"';
const HEADING = '<div style="display: flex; align-items: center; justify-content: space-between; height: 44px">';
const PLAYER = '\n\n<a href="NowPlaying.dc.html"';
{
  let html = source('Library.dc.html');
  const grid = cut(html, '<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px 12px">', `\n</div>${PLAYER}`);
  html = html.slice(0, grid.a) + tiles + html.slice(grid.b);
  html = swap(html, 'aria-label="Add an audiobook"', 'aria-label="Add a book"', 'Library add button');
  html = swap(html, NAV, tabBar('library'), 'Library tab bar');
  const links = { 0: 'Library.dc.html', 1: 'LibrarySeries.dc.html' };
  const filter = cut(html, CHIPS, `\n\n${HEADING}`);
  keep('Library.dc.html', 'Library', 390, 844, html.slice(0, filter.a) + chips(0, links, true) + html.slice(filter.b));

  // The same screen with the Series filter chosen.
  const list = cut(html, HEADING, `\n</div>${PLAYER}`);
  const series = `${HEADING}\n<h2 style="${st.heading}">Series</h2>\n</div>\n\n${group('', seriesRows(false))}\n\n${group('', rows([{ btn: true, label: 'Find a series', chev: true }]))}`;
  let seriesHtml = html.slice(0, list.a) + series + html.slice(list.b);
  const seriesFilter = cut(seriesHtml, CHIPS, `\n\n${HEADING}`);
  seriesHtml = seriesHtml.slice(0, seriesFilter.a) + chips(1, links, true) + seriesHtml.slice(seriesFilter.b);
  seriesHtml = swap(seriesHtml, '<title>Library</title>', '<title>Library: series</title>', 'Library series title');
  keep('LibrarySeries.dc.html', 'Library: series', 390, 844, seriesHtml);
}

// Settings: Activity and Offline copies moved to the Activity place.
{
  let html = source('Settings.dc.html');
  html = swap(html, /<a href="Settings\.dc\.html"[^\n]*>Activity<span[^\n]*\n/, '', 'Settings Activity row');
  html = swap(html, /<a href="Settings\.dc\.html"[^\n]*>Offline copies<span[^\n]*\n/, '', 'Settings Offline copies row');
  html = swap(html, NAV, tabBar('settings'), 'Settings tab bar');
  keep('Settings.dc.html', 'Settings', 390, 844, html);
}

// Settings, Playback: each entry with its tooltip. Reading along has the layout and the following, since one page view is left.
const stepper = (value, less, more) => `<span style="display: flex; align-items: center; gap: 4px"><button type="button" aria-label="${less}" style="width: 44px; height: 36px; border: 0; border-radius: 8px; background: #26331f; color: #e6eadf; font: 500 18px/20px 'DM Sans', sans-serif">−</button><span style="width: 48px; text-align: center; font-size: 14px; line-height: 20px; font-weight: 500">${value}</span><button type="button" aria-label="${more}" style="width: 44px; height: 36px; border: 0; border-radius: 8px; background: #26331f; color: #e6eadf; font: 500 18px/20px 'DM Sans', sans-serif">+</button></span>`;
const choice = (id, items, current, label) => `<div role="group" ${label ? `aria-label="${label}"` : `aria-labelledby="${id}"`} style="display: flex; padding: 4px; border-radius: 8px; background: #26331f; height: 44px; box-sizing: border-box">
${items.map((text, i) => i === current
    ? `<button type="button" aria-pressed="true" style="flex: 1; border: 0; border-radius: 6px; background: #101510; color: #e6eadf; font: 600 14px/20px 'DM Sans', sans-serif">${text}</button>`
    : `<button type="button" aria-pressed="false" style="flex: 1; border: 0; border-radius: 6px; background: transparent; color: #a9b59d; font: 500 14px/20px 'DM Sans', sans-serif">${text}</button>`).join('\n')}
</div>`;
/** An entry whose control needs a line of its own: the name with its tooltip, then the control. */
const block = (id, label, text, control, last) => `<div style="padding: 16px; display: flex; flex-direction: column; gap: 12px${last ? '' : `; border-bottom: 1px solid ${c.line}`}">
<div style="position: relative; display: flex; align-items: center; gap: 4px"><span id="${id}" style="font-size: 16px; line-height: 22px">${label}</span>${tip(label, text, { left: 0, drop: 8 })}</div>
${control}
</div>`;
add('SettingsPlayback.dc.html', 'Settings: Playback', 390, 844, phone(stack(
  backHeader('Settings.dc.html', 'Back to Settings', 'Playback'),
  group('Listening', [
    row({ label: 'Default speed', tip: T.defaultSpeed, right: stepper('1.2×', 'Slower', 'Faster') }, false),
    block('progress-label', 'Progress bar shows', T.progressBar, choice('progress-label', ['Whole audiobook', 'Current chapter'], 0), true),
  ].join('\n')),
  group('Reading', [
    block('mode-label', 'Reading mode', T.readingMode, choice('mode-label', ['Pages', 'Scroll'], 0), false),
    row({ label: 'Follow the narration', tip: T.follow, right: toggle(true, 'Follow the narration') }, true),
  ].join('\n')),
  group('', rows([{ href: 'Settings.dc.html', label: 'Keyboard shortcuts', chev: true }])),
), 'settings'));

// Desktop Library: the rail, the Series filter, what each book has, and the name of the marks on hover.
let desktopHeader;
const libraryChips = (current) => chips(current, { 0: 'DesktopLibrary.dc.html', 1: 'DesktopSeries.dc.html' }, false);
{
  let html = swap(desktopLibrary, NAV, rail('library'), 'Desktop Library rail');
  const progress = (pct) => `<span style="display: block; height: 4px; border-radius: 999px; background: #101510"><span style="display: block; width: ${pct}%; height: 4px; border-radius: 999px; background: {{accent}}"></span></span>`;
  const named = (text) => `<span role="tooltip" style="position: absolute; z-index: 2; left: 12px; bottom: 52px; padding: 6px 8px; border-radius: 8px; background: ${c.text}; color: ${c.ground}; font-family: ${sans}; font-size: 12px; line-height: 16px; font-weight: 600; white-space: nowrap">${text}</span>`;
  const wideTile = (b, marks, pct, name) => `<a href="DesktopLibrary.dc.html" style="display: flex; flex-direction: column; gap: 8px; color: #e6eadf; text-decoration: none"><div style="${name ? 'position: relative; ' : ''}aspect-ratio: 1; border-radius: 8px; background: ${b.col}; padding: 12px; box-sizing: border-box; font-family: 'Manrope', sans-serif; font-weight: 700; font-size: 14px; line-height: 17px; display: flex; flex-direction: column; justify-content: space-between">${b.ct ?? b.t}<span style="display: flex; flex-direction: column; gap: 8px">${pill(marks)}${pct ? progress(pct) : ''}</span>${name ? named(name) : ''}</div><div><div style="font-size: 14px; line-height: 20px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis">${b.t}</div><div style="font-size: 12px; line-height: 16px; color: #a9b59d">${b.a}</div></div></a>`;
  const wideTiles = `<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 24px 16px">
${wideTile(B.anti, has.audio + has.ebook + has.sync, 62, 'Audiobook, ebook, reading sync ready')}
${wideTile(B.snow, `${has.audio}43%`)}
${wideTile(B.matter, has.audio + has.ebook)}
${wideTile(B.dorian, has.audio + has.ebook)}
${wideTile(B.feral, has.audio + has.ebook)}
${wideTile(B.frank, has.ebook)}
</div>`;
  const wideGrid = cut(html, '<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 24px 16px">', '\n\n<section aria-label="Now playing"');
  html = html.slice(0, wideGrid.a) + wideTiles + html.slice(wideGrid.b);
  html = swap(html, '</svg>Add audiobook</button>', '</svg>Add a book</button>', 'Desktop Library add button');
  const filter = cut(html, CHIPS, '\n<button type="button" aria-label="Sort and view: recent, grid"');
  html = html.slice(0, filter.a) + libraryChips(0) + html.slice(filter.b);
  keep('DesktopLibrary.dc.html', 'Desktop: Library', 1280, 800, html, { expand: 'fill' });
  desktopHeader = cut(html, '<header style="display: flex; flex-wrap: wrap; align-items: center; gap: 16px">', '\n\n<div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px">').text;
}

add('DesktopSeries.dc.html', 'Desktop: Series', 1280, 940, desktop('library', stack(
  desktopHeader,
  `<div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px">\n${libraryChips(1)}\n</div>`,
  columns(
    column('1 1 300px', group('', seriesRows(true))),
    column('2 1 420px', stack(detailTitle(culture.name, seriesProgress), seriesBooks)),
  ),
  nowPlayingBar,
), 940), { expand: 'fill' });

// Desktop Settings: two rows moved out, and a tooltip on each connection that needs one.
{
  let html = swap(source('DesktopSettings.dc.html'), NAV, rail('settings'), 'Desktop Settings rail');
  html = swap(html, /<a href="DesktopSettings\.dc\.html"[^\n]*>Activity<span[^\n]*\n/, '', 'Desktop Settings Activity row');
  html = swap(html, /<a href="DesktopSettings\.dc\.html"[^\n]*>Offline copies<\/a>\n/, '', 'Desktop Settings Offline copies row');
  const CLIPPED = '<div style="border-radius: 14px; background: #182117; overflow: hidden">\n';
  const OPEN = '<div style="border-radius: 14px; background: #182117">\n';
  const HEAD = 'min-height: 52px; padding: 0 16px; border-bottom: 1px solid #3c4934; display: flex; align-items: center; justify-content: space-between; gap: 12px';
  const NAME = 'font-size: 16px; line-height: 22px; font-weight: 600';
  const head = (name) => `<div style="${HEAD}"><span style="${NAME}">${name}</span>`;
  const headTip = (name, text) => `<div style="position: relative; ${HEAD}"><div style="display: flex; align-items: center; gap: 4px"><span style="${NAME}">${name}</span>${tip(name, text)}</div>`;
  html = swap(html, CLIPPED + head('TorBox'), OPEN + headTip('TorBox', T.torbox), 'TorBox tooltip');
  html = swap(html, CLIPPED + head('Prowlarr'), OPEN + headTip('Prowlarr', T.prowlarr), 'Prowlarr tooltip');
  html = swap(html, CLIPPED + head('Hardcover'), OPEN + head('Hardcover'), 'Hardcover card');
  const ROW = 'min-height: 52px; padding: 0 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px';
  const progress = 'Sync listening and reading progress';
  html = swap(
    html,
    `<div style="${ROW}"><span style="font-size: 16px; line-height: 22px">${progress}</span>`,
    `<div style="position: relative; ${ROW}"><div style="display: flex; align-items: center; gap: 4px"><span style="font-size: 16px; line-height: 22px">${progress}</span>${tip(progress, T.hardcoverProgress)}</div>`,
    'Hardcover progress tooltip',
  );
  keep('DesktopSettings.dc.html', 'Desktop: Settings', 1280, 800, html, { expand: 'fill' });
}

// Design language: where things live now.
{
  let html = source('Main.dc.html');
  const card = (title, text) => `<div style="border-radius: 14px; background: #182117; padding: 16px; display: flex; flex-direction: column; gap: 8px"><div style="font-family: 'Manrope', sans-serif; font-weight: 700; font-size: 20px; line-height: 26px">${title}</div><div style="font-size: 14px; line-height: 20px; color: #a9b59d">${text}</div></div>`;
  const live = cut(html, '<div style="display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 16px">', '\n</div>\n</div>\n</x-dc>');
  const next = `<div style="display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 16px">
${card('Library', 'Every book, in either format, and your series. Filters replace the shelves list: Series, In progress, Not started, Finished, On device, Favorites.')}
${card('Discover', 'Finds books. A result opens its Book page, and its files are found with Get.')}
${card('Activity', 'Downloads, device copies and reading sync: Now, This device, Server. Replaces the Downloads page.')}
${card('Settings', 'One list in three groups. Users and connections are rows here, not separate places.')}
${card('Book', 'One page for both formats. Its Files rows replace the card menu, the release picker and the versions dialog.')}
${card('Now playing', 'One screen with two faces, Listen and Read, and the same transport in both. Replaces three sheets and the Lyrics and Word views.')}
</div>`;
  html = html.slice(0, live.a) + next + html.slice(live.b);
  html = swap(html, '<span style="font-size: 16px; line-height: 22px">Default speed</span>', '<span style="font-size: 16px; line-height: 22px">Speed</span>', 'Language sample row');
  keep('Main.dc.html', 'Design language', 1280, 1000, html);
}

// ---------------------------------------------------------------- Now playing and the reader

// One screen with two faces, Listen and Read. The sample book is Frankenstein, whose text is in the public domain.
const FONTS_BOOK = 'DM+Sans:wght@400;500;600&family=Manrope:wght@600;700&family=Literata:ital,wght@0,400;1,400';
const LIT = "'Literata', Georgia, serif";
const LINE = 29;
const frank = { ...B.frank, chapter: 'Letter 1' };
const marked = (text) => `<span style="background: color-mix(in srgb, ${acc} 28%, transparent); border-radius: 4px; padding: 1px 0; -webkit-box-decoration-break: clone; box-decoration-break: clone">${text}</span>`;

/** The first paragraphs of Letter 1, sentence by sentence; `on` is the index of the narrated sentence. */
const first = [
  'You will rejoice to hear that no disaster has accompanied the commencement of an enterprise which you have regarded with such evil forebodings.',
  'I arrived here yesterday, and my first task is to assure my dear sister of my welfare and increasing confidence in the success of my undertaking.',
];
const second = [
  'I am already far north of London, and as I walk in the streets of Petersburgh, I feel a cold northern breeze play upon my cheeks, which braces my nerves and fills me with delight.',
  'Do you understand this feeling?',
  'This breeze, which has travelled from the regions towards which I am advancing, gives me a foretaste of those icy climes.',
  'Inspirited by this wind of promise, my daydreams become more fervent and vivid.',
  'I try in vain to be persuaded that the pole is the seat of frost and desolation; it ever presents itself to my imagination as the region of beauty and delight.',
  'There, Margaret, the sun is for ever visible, its broad disk just skirting the horizon and diffusing a perpetual splendour.',
  'There—for with your leave, my sister, I will put some trust in preceding navigators—there snow and frost are banished; and, sailing over a calm sea, we may be wafted to a land surpassing in wonders and in beauty every region hitherto discovered on the habitable globe.',
  'Its productions and features may be without example, as the phenomena of the heavenly bodies undoubtedly are in those undiscovered solitudes.',
  'What may not be expected in a country of eternal light?',
  'I may there discover the wondrous power which attracts the needle and may regulate a thousand celestial observations that require only this voyage to render their seeming eccentricities consistent for ever.',
];
function letter(on) {
  const sentence = (text, i) => (i === on ? marked(text) : text);
  return `<h2 style="margin: 0; padding: ${LINE}px 0; font-family: ${LIT}; font-weight: 400; font-size: 26px; line-height: ${LINE}px">Letter 1</h2>
<p style="margin: 0 0 ${LINE}px; font-style: italic">To Mrs. Saville, England.<br>St. Petersburgh, Dec. 11th, 17—.</p>
<p style="margin: 0">${first.map(sentence).join(' ')}</p>
<p style="margin: 0; text-indent: 1.4em">${second.map((text, i) => sentence(text, i + first.length)).join(' ')}</p>`;
}
/**
 * The text block: whole lines only, `lines` of them, starting `skip` lines into the letter. A page shows what
 * fits and the letter goes on; that cut is on purpose (`data-clip`), not a clipping fault. The scroll layout
 * gives a `height` and a `shift` of a few pixels instead, so its first and last line are cut as a moving column's are.
 */
const bookText = ({ lines, skip = 0, on, shift = 0, height }) => `<div data-clip="page" style="height: ${height ?? lines * LINE}px; overflow: hidden"><div style="margin-top: ${-skip * LINE - shift}px; font-family: ${LIT}; font-size: 18px; line-height: ${LINE}px">
${letter(on)}
</div></div>`;

const face = (current, read = 'Reader.dc.html') => `<div role="group" aria-label="Listen or read" style="width: 136px; height: 44px; flex: none; box-sizing: border-box; padding: 4px; border-radius: 8px; background: ${c.raised}; display: flex">
${[['Listen', 'NowPlaying.dc.html'], ['Read', read]].map(([text, href], i) => i === current
    ? `<a href="${href}" aria-current="page" style="flex: 1; border-radius: 6px; background: ${c.ground}; color: ${c.text}; font-size: 14px; line-height: 20px; font-weight: 600; text-decoration: none; display: flex; align-items: center; justify-content: center">${text}</a>`
    : `<a href="${href}" style="flex: 1; border-radius: 6px; color: ${c.muted}; font-size: 14px; line-height: 20px; font-weight: 500; text-decoration: none; display: flex; align-items: center; justify-content: center">${text}</a>`).join('\n')}
</div>`;
const plain = (icon, label, o = {}) => o.href
  ? `<a href="${o.href}" aria-label="${label}" style="width: 44px; height: 44px; flex: none; border-radius: 8px; color: ${o.color ?? c.text}; font-size: 14px; line-height: 20px; font-weight: 600; text-decoration: none; display: flex; align-items: center; justify-content: center">${icon}</a>`
  : `<button type="button" aria-label="${label}"${o.pressed == null ? '' : ` aria-pressed="${o.pressed}"`}${o.off ? ' aria-disabled="true"' : ''} style="width: 44px; height: 44px; flex: none; border: 0; border-radius: 8px; background: transparent; color: ${o.off ? c.line : o.color ?? c.text}; font: 600 14px/20px ${sans}; display: flex; align-items: center; justify-content: center">${icon}</button>`;
const skip30 = (sign, label) => `<button type="button" aria-label="${label}" style="width: 44px; height: 44px; flex: none; border: 0; border-radius: 999px; background: ${c.raised}; color: ${c.text}; font: 600 12px/16px ${sans}">${sign}30</button>`;
const playButton = (size, playing) => `<button type="button" aria-label="${playing ? 'Pause' : 'Play'}" style="width: ${size}px; height: ${size}px; flex: none; border: 0; border-radius: 999px; background: ${acc}; color: ${c.ground}; display: flex; align-items: center; justify-content: center">${playing ? svg(I.pause, size > 50 ? 28 : 20, { sw: 2.6 }) : svg(I.play, size > 50 ? 28 : 20, { fill: 'currentColor' })}</button>`;
const timeline = (pct, from, left) => `<div style="height: 20px; flex: none; display: flex; align-items: center; gap: 12px; font-size: 12px; line-height: 16px; font-weight: 500; color: ${c.muted}"><span>${from}</span><span aria-hidden="true" style="flex: 1; height: 4px; border-radius: 999px; background: ${c.line}; display: block"><span style="display: block; width: ${pct}%; height: 4px; border-radius: 999px; background: ${acc}"></span></span><span>−${left}</span></div>`;

// The head and the foot of the reader. Both keep their height whether the controls are shown or not,
// so the text block between them never moves and nothing is ever drawn over it.
const quietHead = `<header style="height: 44px; flex: none; display: flex; align-items: center; justify-content: center"><span style="${st.caption}">${frank.t} · ${frank.chapter}</span></header>`;
const controlsHead = (read) => `<header style="height: 44px; flex: none; padding: 0 8px; display: flex; align-items: center; gap: 4px">
${plain(svg(I.down), 'Close', { href: 'Library.dc.html' })}
${face(1, read)}
<span style="flex: 1"></span>
${plain(svg(I.bookmark), 'Bookmark this sentence', { pressed: false })}
${plain(svg(I.search), 'Search this book')}
${plain('Aa', 'Reader appearance', { href: 'ReaderAppearance.dc.html' })}
</header>`;
const quietFoot = `<footer style="height: 72px; flex: none; box-sizing: border-box; padding: 8px 16px 0; display: flex; flex-direction: column; gap: 4px">
<span aria-hidden="true" style="height: 2px; border-radius: 999px; background: ${c.line}; display: block"><span style="display: block; width: 35%; height: 2px; border-radius: 999px; background: ${acc}"></span></span>
<div style="height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 12px"><span style="font-size: 12px; line-height: 16px; font-weight: 500; color: ${c.muted}">${frank.chapter} · 4 min left</span>${plain(svg(I.pause, 20, { sw: 2.6 }), 'Pause', { color: c.muted })}</div>
</footer>`;
const controlsFoot = (following) => `<footer style="height: 72px; flex: none; box-sizing: border-box; padding: 4px 16px 0; display: flex; flex-direction: column; gap: 4px">
${timeline(35, '2:10', '4:05')}
<div style="height: 44px; display: flex; align-items: center; justify-content: space-between">
${plain(svg(I.list), 'Chapters', { href: 'Chapters.dc.html' })}
${plain(svg(I.target), 'Back to narration', { off: following })}
${skip30('−', 'Back 30 seconds')}
${playButton(44, true)}
${skip30('+', 'Forward 30 seconds')}
${plain(svg(I.moon), 'Sleep timer: off')}
${plain('1.2×', 'Speed 1.2 times')}
</div>
</footer>`;
const readerRoot = (head, body, foot) => `<div style="width: 390px; height: 844px; box-sizing: border-box; background: ${c.ground}; color: ${c.text}; font-family: 'DM Sans', system-ui, sans-serif; display: flex; flex-direction: column">
${head}
${body}
${foot}
</div>`;
const pageBody = (text) => `<main style="flex: 1; min-height: 0; box-sizing: border-box; padding: 14px 24px 18px">
${text}
</main>`;
const reader = (name, title, root) => add(name, title, 390, 844, root, { fonts: FONTS_BOOK });

// Now playing, the Listen face: the same transport as under the text, and what the first draft had as two tabs.
add('NowPlaying.dc.html', 'Now playing', 390, 844, sheet(stack(
  `<header style="height: 44px; flex: none; display: flex; align-items: center; justify-content: space-between">
${square(svg(I.down), 'Close now playing', { href: 'Library.dc.html' })}
${face(0)}
${square(svg(I.ebook), 'Open this book’s page', { href: 'Book.dc.html' })}
</header>`,
  `<div style="flex: none; display: flex; align-items: center; gap: 16px">
<div style="width: 120px; height: 120px; flex: none; border-radius: 8px; background: ${frank.col}; padding: 12px; box-sizing: border-box; font-family: 'Manrope', sans-serif; font-weight: 700; font-size: 14px; line-height: 17px">${frank.t}</div>
<div style="min-width: 0; display: flex; flex-direction: column; gap: 4px">
<h1 style="${st.heading}">${frank.t}</h1>
<div style="${st.sub}">${frank.a}</div>
<div style="${st.sub}">${frank.chapter}</div>
</div>
</div>`,
  timeline(35, '2:10', '4:05'),
  `<div style="flex: none; display: flex; align-items: center; justify-content: center; gap: 24px">
<button type="button" aria-label="Rewind 30 seconds" style="width: 56px; height: 56px; border: 0; border-radius: 999px; background: ${c.raised}; color: ${c.text}; font: 600 14px/20px ${sans}">−30</button>
${playButton(72, false)}
<button type="button" aria-label="Forward 30 seconds" style="width: 56px; height: 56px; border: 0; border-radius: 999px; background: ${c.raised}; color: ${c.text}; font: 600 14px/20px ${sans}">+30</button>
</div>`,
  `<div style="border-radius: 14px; background: ${c.surface}">
${rows([
    { label: 'Speed', tip: T.speed, right: stepper('1.2×', 'Slower', 'Faster') },
    { btn: true, label: 'Sleep timer', value: 'Off', chev: true },
    { href: 'Chapters.dc.html', label: 'Chapters', value: frank.chapter, chev: true },
  ])}
</div>`,
  `<div style="border-radius: 14px; background: ${c.surface}">
${rows([
    { btn: true, label: 'Plays from', tip: T.playsFrom, value: 'TorBox stream', chev: true },
    { btn: true, label: 'Earlier positions', tip: T.earlier, value: 'Undo a jump', chev: true },
    { label: 'Keep on this device', tip: T.keep, right: toggle(false, 'Keep on this device') },
  ])}
</div>`,
)));

// The Read face, pages layout. The same page twice: at rest, and with the controls shown in its head and foot.
reader('Reader.dc.html', 'Reader: pages', readerRoot(quietHead, pageBody(bookText({ lines: 24, on: 1 })), quietFoot));
reader('ReaderControls.dc.html', 'Reader: controls shown', readerRoot(controlsHead('Reader.dc.html'), pageBody(bookText({ lines: 24, on: 1 })), controlsFoot(true)));

// Speed takes the place of the transport in the foot. The head, the text and the foot's height are those of the board before.
const speedFoot = `<footer style="height: 72px; flex: none; box-sizing: border-box; padding: 4px 16px 0; display: flex; flex-direction: column; gap: 4px">
${timeline(35, '2:10', '4:05')}
<div style="height: 44px; display: flex; align-items: center; gap: 8px">
<span style="flex: 1; font-size: 16px; line-height: 22px">Speed</span>
${stepper('1.2×', 'Slower', 'Faster')}
<a href="ReaderControls.dc.html" style="height: 44px; padding: 0 4px 0 12px; color: ${acc}; font-size: 14px; line-height: 20px; font-weight: 600; text-decoration: none; display: flex; align-items: center">Done</a>
</div>
</footer>`;
reader('ReaderSpeed.dc.html', 'Reader: speed', readerRoot(controlsHead('Reader.dc.html'), pageBody(bookText({ lines: 24, on: 1 })), speedFoot));

// Scroll layout: one column that moves; the head and foot are the same and the text ends at their edges.
reader('ReaderScroll.dc.html', 'Reader: scroll', readerRoot(
  controlsHead('ReaderScroll.dc.html'),
  `<main style="position: relative; flex: 1; min-height: 0; box-sizing: border-box; padding: 0 24px">
${bookText({ height: 728, skip: 4, on: 4, shift: 12 })}
<span aria-hidden="true" style="position: absolute; top: 220px; right: 6px; width: 3px; height: 96px; border-radius: 999px; background: ${c.line}; display: block"></span>
</main>`,
  controlsFoot(true),
));

// Appearance docks under the text. The page is laid out again in what is left; it is not covered.
reader('ReaderAppearance.dc.html', 'Reader: appearance', readerRoot(
  controlsHead('Reader.dc.html'),
  pageBody(bookText({ lines: 13, skip: 5, on: 1 })),
  `<section aria-label="Reader appearance" style="flex: none; border-radius: 14px 14px 0 0; background: ${c.surface}; display: flex; flex-direction: column">
<div style="height: 52px; padding: 0 8px 0 16px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid ${c.line}"><h2 style="${st.caption}">Reader appearance</h2>${plain(svg(I.close), 'Close appearance', { href: 'ReaderControls.dc.html' })}</div>
${rows([
    { label: 'Reading mode', tip: T.readingMode, right: choice('', ['Pages', 'Scroll'], 0, 'Reading mode').replace('display: flex; padding: 4px;', 'width: 168px; display: flex; padding: 4px;') },
    { label: 'Follow the narration', tip: T.follow, right: toggle(true, 'Follow the narration') },
    { label: 'Theme', right: `<span role="group" aria-label="Theme" style="display: flex">${[['App', c.ground, true], ['Dark', '#000000'], ['Light', '#f6f3ea'], ['Sepia', '#e9dcc3']].map(([name, color, on]) => `<button type="button" aria-label="${name}" aria-pressed="${!!on}" style="width: 44px; height: 44px; border: 0; padding: 6px; background: transparent"><span style="width: 32px; height: 32px; box-sizing: border-box; border: 2px solid ${on ? acc : c.line}; border-radius: 999px; background: ${color}; display: block"></span></button>`).join('')}</span>` },
    { label: 'Font', right: choice('', ['Serif', 'Sans', 'System'], 0, 'Font').replace('display: flex; padding: 4px;', 'width: 216px; display: flex; padding: 4px;') },
    { label: 'Size', right: stepper('19', 'Smaller text', 'Larger text') },
    { label: 'Line height', right: stepper('1.7', 'Tighter lines', 'Looser lines') },
  ])}
</section>`,
));

// A sentence that starts on one page and ends on the next: the page turns when the narration reaches the
// first word of the next page, and the rest of the sentence is still marked there.
const WRAP = 5;
reader('ReaderWrapA.dc.html', 'Reader: across pages, before', readerRoot(quietHead, pageBody(bookText({ lines: 24, on: WRAP })), quietFoot));
reader('ReaderWrapB.dc.html', 'Reader: across pages, after', readerRoot(quietHead, pageBody(bookText({ lines: 24, skip: 24, on: WRAP })), quietFoot));

// Chapters: one list for both faces, with the narrated chapter marked.
const chapter = (name, time, now) => now
  ? { btn: true, pressed: true, sel: true, lead: lead(I.audio, acc), label: name, value: 'Now · 4 min left', valueColor: c.text }
  : { btn: true, pressed: false, label: name, value: time };
add('Chapters.dc.html', 'Chapters', 390, 844, sheet(stack(
  backHeader('ReaderControls.dc.html', 'Back to the book', 'Chapters', frank.t),
  segments('Chapters or bookmarks', [['Chapters', 'Chapters.dc.html'], ['Bookmarks', 'Chapters.dc.html']], 0),
  group('', rows([
    chapter('Letter 1', '', true), chapter('Letter 2', '11 min'), chapter('Letter 3', '3 min'), chapter('Letter 4', '24 min'),
    chapter('Chapter 1', '16 min'), chapter('Chapter 2', '18 min'), chapter('Chapter 3', '21 min'), chapter('Chapter 4', '17 min'),
    chapter('Chapter 5', '19 min'), chapter('Chapter 6', '22 min'), chapter('Chapter 7', '25 min'), chapter('Chapter 8', '20 min'),
  ])),
)));

// The reader on a desktop: the contents sit beside the text and push it, the player is the footer.
const contents = ['Letter 1', 'Letter 2', 'Letter 3', 'Letter 4', 'Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4', 'Chapter 5', 'Chapter 6', 'Chapter 7', 'Chapter 8'];
add('DesktopReader.dc.html', 'Desktop: Reader', 1280, 800, `<div style="min-height: 800px; box-sizing: border-box; background: ${c.ground}; color: ${c.text}; font-family: 'DM Sans', system-ui, sans-serif; display: flex; flex-direction: column">
<header style="height: 60px; flex: none; padding: 0 24px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px">
${plain(svg(I.down), 'Close', { href: 'DesktopLibrary.dc.html' })}
${face(1, 'DesktopReader.dc.html')}
<span style="margin-left: 8px; ${st.caption}">${frank.t} · ${frank.chapter}</span>
<span style="flex: 1"></span>
${plain(svg(I.list), 'Hide contents', { pressed: true })}
${plain(svg(I.bookmark), 'Bookmark this sentence', { pressed: false })}
${plain(svg(I.search), 'Search this book')}
${plain('Aa', 'Reader appearance')}
</header>
<div style="flex: 1; display: flex; flex-wrap: wrap">
<nav aria-label="Contents" style="flex: 1 1 220px; max-width: 280px; box-sizing: border-box; padding: 8px 16px 24px 24px; display: flex; flex-direction: column; gap: 4px">
<h2 style="${st.caption}; padding: 8px 12px">Contents</h2>
${contents.map((name, i) => i === 0
    ? `<button type="button" aria-current="true" style="height: 44px; padding: 0 12px; border: 0; border-radius: 8px; background: ${c.raised}; color: ${c.text}; font: 600 14px/20px ${sans}; text-align: left; display: flex; align-items: center; gap: 8px">${svg(I.audio, 16, { stroke: acc, label: 'Narrating' })}${name}</button>`
    : `<button type="button" style="height: 44px; padding: 0 12px; border: 0; border-radius: 8px; background: transparent; color: ${c.muted}; font: 500 14px/20px ${sans}; text-align: left">${name}</button>`).join('\n')}
</nav>
<main style="flex: 999 1 560px; min-width: 0; box-sizing: border-box; padding: 8px 24px 16px; display: flex; align-items: center; justify-content: center; gap: 16px">
${plain(svg(I.back), 'Previous page', { color: c.muted })}
<div style="flex: 0 1 620px; min-width: 0">
${bookText({ lines: 21, on: 1 })}
</div>
${plain(svg(I.chev, 20), 'Next page', { color: c.muted })}
</main>
</div>
<footer style="flex: none; box-sizing: border-box; padding: 12px 24px 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 16px; border-top: 1px solid ${c.line}">
<div style="display: flex; align-items: center; gap: 8px">${plain(svg(I.target), 'Back to narration', { off: true })}${skip30('−', 'Back 30 seconds')}${playButton(44, true)}${skip30('+', 'Forward 30 seconds')}</div>
<div style="flex: 1 1 320px; min-width: 0">${timeline(35, '2:10', '4:05')}</div>
<div style="display: flex; align-items: center; gap: 8px">${plain(svg(I.moon), 'Sleep timer: off')}${plain('1.2×', 'Speed 1.2 times')}</div>
</footer>
</div>`, { expand: 'fill', fonts: FONTS_BOOK });

// ---------------------------------------------------------------- Language: reading

const spec = (title, body) => `<div style="display: flex; flex-direction: column; gap: 12px">
<h2 style="${st.caption}">${title}</h2>
${body}
</div>`;
const band = (label, height, fill, color = c.muted) => `<div style="height: ${height}px; border-radius: 6px; background: ${fill}; color: ${color}; font-size: 12px; line-height: 16px; font-weight: 500; display: flex; align-items: center; justify-content: center">${label}</div>`;
// A time line of three sentences with silences between them, and how long each one stays marked.
const span = (label, flex, fill, color = c.ground) => `<div style="flex: ${flex}; min-width: 0; height: 28px; border-radius: 6px; background: ${fill}; color: ${color}; font-size: 12px; line-height: 16px; font-weight: 600; display: flex; align-items: center; justify-content: center">${label}</div>`;
const gapSpan = (flex) => `<div style="flex: ${flex}; height: 28px"></div>`;
const track = (label, cells) => `<div style="display: flex; align-items: center; gap: 12px"><span style="width: 72px; flex: none; font-size: 12px; line-height: 16px; color: ${c.muted}">${label}</span><div style="flex: 1; min-width: 0; display: flex; gap: 2px">${cells.join('')}</div></div>`;
const miniPage = (lines, from, to, turn) => `<div style="flex: 1; min-width: 0; border-radius: 8px; background: ${c.surface}; padding: 12px; display: flex; flex-direction: column; gap: 6px">
${Array.from({ length: lines }, (_, i) => `<span aria-hidden="true" style="height: 6px; border-radius: 3px; background: ${i >= from && i <= to ? acc : c.line}; width: ${i === to && to !== lines - 1 ? 60 : 100}%; display: block"></span>`).join('\n')}
<span style="margin-top: 4px; font-size: 12px; line-height: 16px; color: ${c.muted}">${turn}</span>
</div>`;

add('LanguageReader.dc.html', 'Design language: reading', 1280, 832, `<div style="width: 1280px; height: 832px; box-sizing: border-box; padding: 48px; background: ${c.ground}; color: ${c.text}; font-family: 'DM Sans', system-ui, sans-serif; display: flex; flex-direction: column; gap: 32px">
<div style="display: flex; align-items: baseline; justify-content: space-between; gap: 24px">
<h1 style="${st.title}">Reading</h1>
<p style="margin: 0; ${st.sub}">One view in two reading modes. Controls stay out of the text, and the narrated sentence stays highlighted.</p>
</div>

<div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 32px">

<div style="display: flex; flex-direction: column; gap: 24px">
${spec('Where the controls go', stack(
    `<div style="width: 180px; border-radius: 14px; background: ${c.surface}; padding: 8px; display: flex; flex-direction: column; gap: 4px">
${band('Head · 44', 28, c.raised)}
${band('Text', 196, c.ground, c.text)}
${band('Foot · 72', 44, c.raised)}
</div>`,
    term('Head and foot', 'Controls appear in the head and the foot. Both keep their height when the controls are hidden, so the text block never moves and nothing is drawn over it.'),
    term('At rest', 'The head shows the book and chapter. The foot shows the time left, a thin progress line and Pause. A tap on the text shows the controls, and the next tap hides them.'),
    term('Under the text', 'Appearance docks under the text, which is laid out again in what is left.'),
    term('In the foot', 'Speed and the sleep timer take the place of the transport, with Done. Messages such as Undo appear there too. The text does not move.'),
    term('A panel that takes you elsewhere', 'Chapters, bookmarks and search are pages of their own.'),
  ).replaceAll('\n\n', '\n'))}
</div>

<div style="display: flex; flex-direction: column; gap: 24px">
${spec('The highlight stays until the next sentence starts', stack(
    `<div style="border-radius: 14px; background: ${c.surface}; padding: 16px; display: flex; flex-direction: column; gap: 8px">
${track('Narration', [span('1', 5, c.muted), gapSpan(2), span('2', 4, c.muted), gapSpan(3), span('3', 5, c.muted)])}
${track('Highlighted', [span('Sentence 1', 7, acc), span('Sentence 2', 7, acc), span('Sentence 3', 5, acc)])}
</div>`,
    term('In a silence', 'A sentence stays highlighted after its last word, through a pause, music or a passage the ebook does not have, until the next sentence starts.'),
    term('After a jump', 'The highlighted sentence is the last one that started before the new position.'),
    term('The highlight', 'The accent at about a quarter strength behind the sentence, from its first to its last character.'),
  ).replaceAll('\n\n', '\n'))}
${spec('Pages or scroll', stack(
    term('One view', 'The book as its own text. The Lyrics and Word views are gone, and with them Words per minute.'),
    term('Two reading modes', 'Pages turns page by page, with whole lines only. Scroll is one column that moves. Reading mode is the first row of Appearance; switching keeps the place and the highlight.'),
    term('Scroll while following', 'The highlighted sentence is kept in the upper half. A touch on the text stops the following; Back to narration resumes it.'),
  ).replaceAll('\n\n', '\n'))}
</div>

<div style="display: flex; flex-direction: column; gap: 24px">
${spec('A sentence across two pages', stack(
    `<div style="display: flex; gap: 12px">
${miniPage(7, 5, 6, 'Page 12')}
${miniPage(7, 0, 1, 'Page 13')}
</div>`,
    term('Both parts are highlighted', 'The sentence is one highlight that happens to sit on two pages.'),
    term('When the page turns', 'When the narration reaches the first word on the next page. The sentence’s time is spread over its words to find that moment, so it is an estimate: about a second early or late.'),
    term('Not at either end', 'The page does not turn at the start of the sentence, and it does not wait for the next sentence while the narrator reads words you cannot see.'),
    term('Paused or paged away', 'A pause keeps the page. If you turned the page yourself, nothing turns until Back to narration.'),
  ).replaceAll('\n\n', '\n'))}
</div>

</div>
</div>`);

// ---------------------------------------------------------------- Tooltips: the pattern and every text

const tipEntry = ([name, text]) => `<div><div style="${st.label}">${name}</div><div style="font-size: 12px; line-height: 16px; color: ${c.muted}">${text}</div></div>`;
const tipGroup = ([screen, entries]) => `<div style="display: flex; flex-direction: column; gap: 12px">
<h2 style="${st.caption}">${screen}</h2>
${entries.map(tipEntry).join('\n')}
</div>`;
const tipColumn = (lead, names) => `<div style="display: flex; flex-direction: column; gap: 32px">
${[lead, ...tipGroups.filter(([screen]) => names.includes(screen)).map(tipGroup)].filter(Boolean).join('\n')}
</div>`;
const listed = ['Book', 'Audiobook', 'Ebook', 'Get audiobook, Get ebook', 'Reading sync', 'Series', 'Activity, Now', 'Activity, Server', 'Activity, This device', 'Worker', 'Now playing', 'Reader', 'Settings, Playback', 'Settings, Connections'];
const unlisted = tipGroups.map(([screen]) => screen).filter((screen) => !listed.includes(screen));
if (unlisted.length) throw new Error(`Tooltip groups without a column: ${unlisted.join(', ')}`);
const TOOLTIPS_H = 1580;
const sampleRow = (open) => `<div style="border-radius: 14px; background: ${c.surface}${open ? '; margin-bottom: 132px' : ''}">
${row({ label: 'Protected storage', tip: T.protectedStorage, tipOpen: open, value: 'On' })}
</div>`;
const pattern = `<div style="display: flex; flex-direction: column; gap: 12px">
<h2 style="${st.caption}">The tooltip</h2>
${sampleRow(false)}
${sampleRow(true)}
${term('Where', 'After the name of a row, a group caption or a page title.')}
${term('When', 'A word of the app, a switch whose effect its label does not say, or a figure that needs reading.')}
${term('When not', 'A name that says it all. And anything to read before acting: that stays on the page.')}
${term('Text', 'One to three sentences: what it is, then what it does. A switch says what Off does.')}
${term('Shape', 'Light fill, dark text, 14/20, corner 8, up to 300 wide, with a pointer to its mark.')}
${term('Opens', 'With a tap on the mark; a tap elsewhere closes it. On a desktop also on hover and on keyboard focus. One at a time.')}
${term('Name tooltip', 'An icon without a label shows its name on hover: 12/16, one line.')}
<div style="display: flex; align-items: center; gap: 8px">${square(svg(I.trash), 'Remove from this device', { quiet: true })}<span role="tooltip" style="padding: 6px 8px; border-radius: 8px; background: ${c.text}; color: ${c.ground}; font-size: 12px; line-height: 16px; font-weight: 600; white-space: nowrap">Remove from this device</span></div>
</div>`;

add('Tooltips.dc.html', 'Design language: tooltips', 1280, TOOLTIPS_H, `<div style="width: 1280px; height: ${TOOLTIPS_H}px; box-sizing: border-box; padding: 48px; background: ${c.ground}; color: ${c.text}; font-family: 'DM Sans', system-ui, sans-serif; display: flex; flex-direction: column; gap: 32px">
<div style="display: flex; align-items: baseline; justify-content: space-between; gap: 24px">
<h1 style="${st.title}">Tooltips</h1>
<p style="margin: 0; ${st.sub}">An entry that needs explaining carries an info mark. Its explanation opens on demand.</p>
</div>

<div style="display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 32px">
${tipColumn(pattern, ['Book', 'Audiobook'])}
${tipColumn('', ['Ebook', 'Get audiobook, Get ebook', 'Reading sync', 'Series'])}
${tipColumn('', ['Activity, Now', 'Activity, Server'])}
${tipColumn('', ['Activity, This device', 'Worker', 'Now playing', 'Reader', 'Settings, Playback', 'Settings, Connections'])}
</div>
</div>`);

// ---------------------------------------------------------------- canvas.json

const index = JSON.parse(source('canvas.json'));
const place = (name, x, y) => {
  if (!boards[name]) throw new Error(`No board ${name}`);
  const { w, h, title, ...extra } = boards[name];
  index.boards[name] = { ...(index.boards[name] ?? {}), x, y, w, h, title, ...extra };
};
const rowOf = (y, names, x = 0) => {
  for (const name of names) {
    place(name, x, y);
    x += boards[name].w + 80;
  }
  return x - 80;
};
// Boards the canvas already has keep their frames; only their sizes and titles are read back from above.
for (const [name, frame] of Object.entries(index.boards)) place(name, frame.x, frame.y);
place('LanguageFiles.dc.html', 1360, 0);
place('Tooltips.dc.html', 2720, 0);
place('LanguageReader.dc.html', 4080, 0);
const filesRow = ['BookGetting.dc.html', 'BookMore.dc.html', 'Audiobook.dc.html', 'Ebook.dc.html', 'GetAudiobook.dc.html', 'GetEbook.dc.html'];
const syncRow = ['ReadingSync.dc.html', 'ReadingSyncReady.dc.html', 'ReadingSyncStopped.dc.html'];
const activityRow = ['Activity.dc.html', 'ActivityDevice.dc.html', 'ActivityServer.dc.html', 'Worker.dc.html', 'DesktopActivity.dc.html', 'DesktopActivityServer.dc.html'];
const seriesRow = ['BookSeries.dc.html', 'Series.dc.html', 'SeriesAdd.dc.html', 'LibrarySeries.dc.html', 'DesktopSeries.dc.html'];
const filesWidth = rowOf(3664, filesRow);
const syncWidth = rowOf(4848, syncRow);
const activityWidth = rowOf(6032, activityRow);
const seriesWidth = rowOf(7252, seriesRow);
const readingRow = ['Reader.dc.html', 'ReaderControls.dc.html', 'ReaderSpeed.dc.html', 'ReaderScroll.dc.html', 'ReaderAppearance.dc.html', 'ReaderWrapA.dc.html', 'ReaderWrapB.dc.html', 'Chapters.dc.html', 'DesktopReader.dc.html'];
const readingWidth = rowOf(8532, readingRow);
index.notes.files = { x: 0, y: 3404, text: 'A book and its files', kind: 'title1', maxW: filesWidth };
index.notes.sync = { x: 0, y: 4588, text: 'Reading sync', kind: 'title1', maxW: syncWidth };
index.notes.activity = { x: 0, y: 5772, text: 'Activity', kind: 'title1', maxW: activityWidth };
index.notes.series = { x: 0, y: 6992, text: 'Series', kind: 'title1', maxW: seriesWidth };
index.notes.reading = { x: 0, y: 8272, text: 'Listening and reading', kind: 'title1', maxW: readingWidth };
const sticky = (x, y, text) => ({ x, y, w: 340, text });
index.notes.filesNew = sticky(filesWidth + 80, 3664, 'New behaviour on these boards: Keep on this device is one switch for the whole book (audiobook, ebook and the reading sync map), and a book with only an ebook sits in the Library. The Book page goes on below the files: the description, Hardcover, Mark as finished and Remove (Book: further down). The rest gives a new home to what the app does today.');
index.notes.syncSteps = sticky(syncWidth + 80, 4848, 'The steps are those of the whole-book job that production runs. The chapter matcher of the older engine is not drawn.');
index.notes.activityPlace = sticky(activityWidth + 80, 6032, 'Activity is a fourth place. It takes over the Downloads page, Settings, Activity and Settings, Reading sync. The phone Server board shows the top of a longer list; the desktop board shows all of it.');
index.notes.seriesPage = sticky(seriesWidth + 80, 7252, 'A series is a page, not a dialog. Its books are listed in reading order with the row used everywhere else, and each one opens its book. A book says which series it belongs to under its author. Add and the two Get switches are today’s Add selected works and its two search options.');
index.notes.readingRules = sticky(readingWidth + 80, 8532, 'Now playing (in the first row) has two faces, Listen and Read, with the same transport. The Lyrics and Word views are gone; Reading mode (Pages or Scroll) is the first row of Appearance. Speed and the sleep timer take the place of the transport in the foot (Reader: speed). Controls only appear in the head and the foot of the page, which keep their height, so the text does not move and is never covered. The two boards "across pages" show one sentence before and after the page turns. The rules are on the Reading board at the top.');
index.notes.tooltipMarks = sticky(5440, 0, 'An info mark opens its tooltip on a tap in Play mode. Three are drawn open: on Book, on Worker and on the desktop Server board. Every text is listed on the Tooltips board.');
index.order = [...index.order, 'LanguageFiles.dc.html', 'Tooltips.dc.html', 'LanguageReader.dc.html', ...filesRow, ...syncRow, ...activityRow, ...seriesRow, ...readingRow];
const absent = Object.keys(boards).filter((name) => !index.order.includes(name));
if (absent.length) throw new Error(`Not on the canvas: ${absent.join(', ')}`);
writeFileSync(join(OUT, 'canvas.json'), JSON.stringify(index));
console.log(`${Object.keys(boards).length} boards written to ${OUT}`);
