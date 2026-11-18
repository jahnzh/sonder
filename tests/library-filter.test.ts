import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LibraryWork } from '../src/types.ts';
import { filterLibrary, migrateFavorites, latestPlace } from '../src/pages/library-filter.ts';

const base = (id: string, changes: Partial<LibraryWork> = {}): LibraryWork => ({ workId:id, title:id, author:'Author', description:'', genre:'', year:2000, cover:'', inLibrary:true, addedAt:1, finished:false, completionOverride:null, chosenRecordingId:null, recordings:[], chosenEbookId:null, ebooks:[], readingSync:[], series:[], mediaState:null, hardcover:null, ...changes });
const ebook = (format: string, progression: number | null = null) => ({id:format, format, available:true, size:1, check:null, place: progression === null ? null : {progression, origin:'reading' as const, updatedAt:42}});
const works = [base('epub', {ebooks:[ebook('epub')]}), base('pdf', {ebooks:[ebook('pdf')]}), base('nothing'), base('downloading'), base('reading', {ebooks:[ebook('epub', .4)]}), base('finished', {finished:true}), base('favorite')];
const select = (chip: string, query = '') => filterLibrary(works, chip, query, ['favorite'], new Set(['pdf']), 'all', 'all').map(w => w.workId);
test('Library chips and search use works and reading places', () => {
  assert.deepEqual(select('All books'), works.map(w => w.workId));
  assert.deepEqual(select('In progress'), ['reading']);
  assert.deepEqual(select('Finished'), ['finished']);
  assert.deepEqual(select('Not started'), ['epub', 'pdf', 'nothing', 'downloading', 'favorite']);
  assert.deepEqual(select('On device'), ['pdf']);
  assert.deepEqual(select('Favorites'), ['favorite']);
  assert.deepEqual(select('All books', 'PDF'), ['pdf']);
  assert.equal(latestPlace(works[4]), 42);
});
test('favorite migration maps editions including placeholders and drops unknowns', () => {
  assert.deepEqual(migrateFavorites(['a','b','placeholder','unknown'], [{id:'a', workId:'one'}, {id:'b', workId:'one'}, {id:'placeholder', workId:'two'}]), ['one','two']);
});
test('search matches authors case insensitively and Continue orders individual places', () => {
  assert.deepEqual(select('All books', 'aUtHoR'), works.map(w => w.workId));
  assert.deepEqual(select('All books', 'missing'), []);
  assert.equal(latestPlace(base('empty')), 0);
  assert.equal(latestPlace(works[4]), 42);
});
