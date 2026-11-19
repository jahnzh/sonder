// The one text of every tooltip. The boards and the tooltip overview both read it here, so they cannot drift apart.

export const T = {
  // Book
  readingSync: 'The ebook follows the narration: the sentence being read aloud is highlighted, and any sentence can start the audio from its place. It needs an audiobook and an EPUB of the same book.',
  keep: 'On: this device keeps the audiobook, the ebook and the reading sync, and saves what arrives later, so the book works without a connection. Off removes them from this device only, after asking. Your place is kept.',

  // Audiobook
  recordings: 'Each recording keeps its own place. When you choose another one, Sonder asks where to resume.',
  audioFrom: 'Where this recording can be played from: a copy on this device, which works offline, a copy on your server, or the stream it was added from.',
  playsFrom: 'Automatic uses the device copy when there is one, then the server copy, then the original stream. Changing it keeps your place.',
  problem: 'Marks this recording, or one copy of it, as faulty and says why. A faulty copy is not played until the mark is cleared.',

  // Ebook
  editions: 'Each EPUB is compared with the narration before reading sync uses it. One with other text, such as another translation, does not match and is left out. A PDF is kept for other apps.',
  ebookFrom: 'Where this edition is kept: on this device, where it opens without a connection, and on your server.',
  exportFile: 'Downloads the file out of Sonder, for example to read it in another app.',


  // Get sheets
  getRecordings: 'Plays now: TorBox already has it, so it plays at once. The others are downloaded to your server first. More seeders means a faster download; with none it may never finish.',
  getEditions: 'An EPUB opens in the reader and can follow the narration. A PDF is kept for other apps.',

  // Reading sync
  syncTitle: 'The ebook follows the narration. It is prepared for one recording and one edition; another recording or edition needs its own.',
  preparing: 'A worker listens to the whole audiobook, finds where the text of the ebook is spoken and gives every sentence a time. It runs on your own machines and takes a while for a long book.',
  ready: 'Every sentence has a start and an end time worked out from the narration. They are estimates: a sentence can be highlighted a little early or late.',
  mapped: 'The share of the ebook’s sentences that were found in the narration. The rest is listed under Unsynced passages.',
  unsynced: 'Parts of the ebook with no place in the audio: pages the narrator does not read, or passages that could not be matched. The reader does not follow the narration there.',
  prepareAgain: 'Prepares the reading sync again from the start. The one you have stays in use until the new one is ready.',
  stopped: 'No worker finished this book. The reason is listed for each worker.',

  // Series
  seriesBooks: 'The reading order, from Hardcover. A book you add joins your library; Sonder looks for its files if you asked for that.',
  seriesAudio: 'For every book you add, Sonder looks for a recording and downloads the best match to your server. Activity shows it.',
  seriesEbooks: 'For every book you add, Sonder looks for an EPUB and saves it on your server.',

  // Activity, Now
  attention: 'Work that failed, or that has not moved for longer than is normal for its kind.',
  progress: 'Work on the server keeps going when Sonder is closed. Saving to this device needs Sonder open.',
  waiting: 'Queued behind other work, paused, or waiting for something it needs, such as a free worker.',
  finished: 'Finished work stays listed for 24 hours.',

  // Activity, This device
  used: 'Space taken by the books kept on this device, out of what the browser lets Sonder use.',
  protectedStorage: 'On: the browser keeps these files when the device runs low on space. Off: it may clear them, and the books would have to be saved again.',
  kept: 'Books whose files are saved here. Removing one frees the space; the book and your place stay.',

  // Activity, Server
  syncQueue: 'Off: no new reading sync starts. One that is running finishes.',
  prepareAll: 'Queues reading sync for every book that has an EPUB and an audiobook on the server and is not prepared yet.',
  workers: 'The machines that prepare reading sync and check ebooks against the narration. One with a GPU is used first; one with a CPU is the fallback.',
  downloadQueue: 'Off: Sonder stops checking downloads, so finished ones do not join the library. They keep downloading in the torrent client.',
  torrent: 'The program on your server that downloads what TorBox does not have.',
  copies: 'Off: no new copy to the server starts. One that is running finishes.',
  seriesSearch: 'Off: no new search or download for a series starts.',
  ebookChecks: 'Off: no new check of an ebook against the narration starts. One that is running finishes. Turning the reading sync queue off holds these checks too.',
  backups: 'Off: no new daily backup starts. One that is running finishes. A deploy still makes its own backup.',
  imports: 'Imports run, but their progress is not shown here yet.',

  // Worker
  codeVersion: 'The version of the worker program on this machine. Every worker should show the same one.',
  useWorker: 'Off: this worker gets no new work. Work that is running there finishes.',
  restart: 'Restarts the worker program on this machine. Sonder asks first and gives it no new work meanwhile. While it is busy, it offers Restart anyway.',

  // Reader
  readingMode: 'Pages turns page by page. Scroll is one column that moves. Switching keeps your place and the highlighted sentence.',
  follow: 'On: the reader keeps the sentence being read aloud in view and highlights it. Off: the page stays where you put it and nothing is highlighted.',

  // Now playing
  speed: 'Remembered for this recording on this device. Other recordings use the default from Settings.',
  earlier: 'Where you were before a jump. Kept on this device for 24 hours, up to 20 places for each recording.',

  // Settings, Playback
  defaultSpeed: 'Used by every recording that has no speed of its own.',
  progressBar: 'Whole audiobook spans all its files. Current chapter follows the chapters inside the files.',

  // Settings, Connections
  torbox: 'Asked first for every recording. What TorBox already has plays at once; the rest is downloaded.',
  prowlarr: 'Adds the indexers of your Prowlarr to the recording search. Sonder only reads from it.',

  // Settings, the detail pages (#472)
  density: 'Compact puts less space around rows and groups, so more fits on the screen.',
  readerTheme: 'The colours of the book’s pages in the reader. App uses the colours of the app.',
  mediaDrive: 'The drive on your server that holds the audiobooks and ebooks. While it is not connected, nothing is saved to it.',
  resetDevice: 'Reloads the app’s files and clears what it keeps for streaming. Books kept on this device, your places and your settings stay.',
};

/** Screen, then its entries in the order they appear: [the entry's name, its tooltip]. */
export const tipGroups = [
  ['Book', [['Reading sync', T.readingSync], ['Keep on this device', T.keep]]],
  ['Audiobook', [['Recordings', T.recordings], ['Available from', T.audioFrom], ['Plays from', T.playsFrom], ['Report a problem', T.problem]]],
  ['Ebook', [['Editions', T.editions], ['Available from', T.ebookFrom], ['Export the file', T.exportFile]]],
  ['Get audiobook, Get ebook', [['Recordings', T.getRecordings], ['Editions', T.getEditions]]],
  ['Reading sync', [['Reading sync (the title)', T.syncTitle], ['Preparing', T.preparing], ['Ready', T.ready], ['Text mapped', T.mapped], ['Unsynced passages', T.unsynced], ['Prepare again', T.prepareAgain], ['Stopped', T.stopped]]],
  ['Series', [['Books', T.seriesBooks], ['Get the audiobooks', T.seriesAudio], ['Get the ebooks', T.seriesEbooks]]],
  ['Activity, Now', [['Needs attention', T.attention], ['In progress', T.progress], ['Waiting', T.waiting], ['Finished today', T.finished]]],
  ['Activity, This device', [['Used by Sonder', T.used], ['Protected storage', T.protectedStorage], ['Kept on this device', T.kept]]],
  ['Activity, Server', [['Reading sync queue', T.syncQueue], ['Prepare for all books', T.prepareAll], ['Workers', T.workers], ['Download queue', T.downloadQueue], ['Torrent client', T.torrent], ['Copies to server', T.copies], ['Series search', T.seriesSearch], ['Ebook checks', T.ebookChecks], ['Database backups', T.backups], ['Imports', T.imports]]],
  ['Worker', [['Code version', T.codeVersion], ['Use this worker', T.useWorker], ['Restart', T.restart]]],
  ['Now playing', [['Speed', T.speed], ['Earlier positions', T.earlier]]],
  ['Reader', [['Reading mode', T.readingMode], ['Follow the narration', T.follow]]],
  ['Settings, Playback', [['Default speed', T.defaultSpeed], ['Progress bar shows', T.progressBar]]],
  ['Settings, Connections', [['TorBox', T.torbox], ['Prowlarr', T.prowlarr]]],
  ['Settings, Appearance', [['Density', T.density], ['Reader theme', T.readerTheme]]],
  ['Settings, Library and storage', [['Media drive', T.mediaDrive]]],
  ['Settings, App', [['Reset this device', T.resetDevice]]],
];
