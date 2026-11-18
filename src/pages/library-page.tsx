import { useState, type ReactNode } from 'react';
import { Search, Plus, Headphones, BookOpen, Link, ArrowDownToLine } from 'lucide-react';
import type { LibraryWork } from '../types';
import { Chip } from '../parts/Chip';
import { coverMarks, COVER_MARK_NAMES } from '../cover-marks';
import { workProgress } from '../work-progress';
import { filterLibrary, latestPlace, progressFraction } from './library-filter';
import { HardcoverLibraryFilters, type HardcoverFilter } from '../components/Hardcover';
import { SeriesList } from './library-series';
import { SERIES_CHIP, type SavedSeriesItem } from './library-series-model';
import type { Notify, Page } from './shared';

export type LibraryAction = 'add' | 'remove' | 'finished' | 'unread';
export function LibraryPage({ works, query, setQuery, filter, setFilter, view, setView, sort, setSort, hardcoverFilter, setHardcoverFilter, savedSeries, openSeries, findSeries, beside, favorites, onDevice, openWork, navigate, refresh, notify }: {
  works: LibraryWork[]; query: string; setQuery: (v: string) => void; filter: string; setFilter: (v: string) => void;
  view: 'grid' | 'list'; setView: (v: 'grid' | 'list') => void; sort: string; setSort: (v: string) => void;
  hardcoverFilter: HardcoverFilter; setHardcoverFilter: (v: HardcoverFilter) => void;
  savedSeries: {items: SavedSeriesItem[] | undefined; error: string}; openSeries: (id: number) => void; findSeries: () => void;
  beside?: {id: number; page: ReactNode} | null; favorites: string[]; onDevice: ReadonlySet<string>;
  openWork: (id: string) => void; navigate: (p: Page) => void; refresh: () => Promise<void>; notify: Notify;
}) {
  const [searching, setSearching] = useState(false);
  const seriesShown = !!beside || filter === SERIES_CHIP;
  const visible = filterLibrary(works, filter, query, favorites, onDevice, hardcoverFilter.shelf, hardcoverFilter.list);
  visible.sort((a, b) => (sort === 'title' ? a.title.localeCompare(b.title) : sort === 'author' ? a.author.localeCompare(b.author) : sort === 'progress' ? progressFraction(b) - progressFraction(a) : (b.addedAt ?? 0) - (a.addedAt ?? 0)) || a.title.localeCompare(b.title));
  const featured = works.filter((w) => workProgress(w) === 'in-progress').sort((a, b) => latestPlace(b) - latestPlace(a))[0];
  const clear = () => { setFilter('All books'); setQuery(''); setHardcoverFilter({shelf: 'all', list: 'all'}); };
  return <>
    <div className="page-heading library-new-head">
      {searching ? <input autoFocus aria-label="Search your library" placeholder="Title or author" value={query} onChange={(e) => setQuery(e.target.value)} /> : <h1>Library</h1>}
      <button className="icon-button" aria-label="Search library" onClick={() => { setSearching(!searching); if (searching) setQuery(''); }}><Search size={20}/></button>
      <button className="icon-button" aria-label="Add a book" onClick={() => navigate('discover')}><Plus size={22}/></button>
    </div>
    {!seriesShown && filter === 'All books' && !query && hardcoverFilter.shelf === 'all' && hardcoverFilter.list === 'all' && featured && <section className="library-continue"><span>Continue</span><button onClick={() => openWork(featured.workId)}>{featured.title} · {featured.author}</button></section>}
    <section className="library-section">
      <div className="library-chips" aria-label="Filter your library">{['All books', SERIES_CHIP, 'In progress', 'Not started', 'Finished', 'On device', 'Favorites'].map((chip) => <Chip key={chip} selected={(beside ? SERIES_CHIP : filter) === chip} onClick={() => { setFilter(chip); if (beside) navigate('library'); }}>{chip === 'All books' ? 'All' : chip}</Chip>)}</div>
      {seriesShown ? beside ? <div className="library-series-beside"><SeriesList {...savedSeries} query={query} current={beside.id} beside onOpen={openSeries} onFind={findSeries}/><div className="library-series-shown">{beside.page}</div></div> : <SeriesList {...savedSeries} query={query} onOpen={openSeries} onFind={findSeries}/> : <>
        <div className="section-heading"><h2>{filter}</h2><div className="view-toggle"><button aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => setView('grid')}>Grid</button><button aria-label="List view" aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button><label>Sort <select aria-label="Sort books" value={sort} onChange={(e) => setSort(e.target.value)}><option value="recent">Recently added</option><option value="title">Title</option><option value="author">Author</option><option value="progress">Progress</option></select></label></div></div>
        <HardcoverLibraryFilters filter={hardcoverFilter} onFilter={setHardcoverFilter} onSettings={() => navigate('settings')} onChanged={refresh} notify={notify}/>
        {visible.length ? <div className={`books-${view} library-work-tiles`}>{visible.map((work) => { const marks = coverMarks(work); return <article className="library-work" key={work.workId}><button className="library-work-open" onClick={() => openWork(work.workId)} aria-label={`About ${work.title}`}><span className="library-work-cover"><img src={work.cover} alt="" loading="lazy"/>{(marks.kind === 'downloading' || marks.marks.length > 0) && <span className="library-work-marks">{marks.kind === 'downloading' ? <><ArrowDownToLine size={14}/>{marks.percent}%</> : marks.marks.map((mark) => <span key={mark} aria-label={COVER_MARK_NAMES[mark]} title={COVER_MARK_NAMES[mark]}>{mark === 'audiobook' ? <Headphones size={14}/> : mark === 'ebook' ? <BookOpen size={14}/> : <Link size={14}/>}</span>)}</span>}</span><strong>{work.title}</strong><span>{work.author}</span></button></article>; })}</div> : <div className="library-empty"><h2>{works.length ? 'No books' : 'No books yet'}</h2><button className="button primary" onClick={works.length ? clear : () => navigate('discover')}>{works.length ? 'Clear filters' : 'Find a book'}</button></div>}
      </>}
    </section>
  </>;
}
