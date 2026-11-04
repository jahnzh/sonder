// Test-only Hardcover transport. Never bundled into the production server.
export function installHardcoverFixture() {
  const original = globalThis.fetch;
  const edition = {
    id: 9501,
    audio_seconds: 21454,
    edition_format: "Audiobook",
    contributions: [
      { contribution: "narrator", author: { name: "Kara Shallenberg" } },
    ],
  };
  const book = (id: number, title: string, author: string) => ({
    id,
    title,
    slug: title.toLowerCase().replaceAll(" ", "-"),
    pages: 200,
    description: "A story from your Hardcover reading shelf.",
    release_year: 2020,
    cached_image: null,
    contributions: [{ contribution: "author", author: { name: author } }],
    book_series: [],
    default_audio_edition: id === 501 ? edition : null,
    editions: id === 501 ? [edition] : [],
  });
  const books = [
    book(501, "Alice’s Adventures in Wonderland", "Lewis Carroll"),
    book(502, "The Quiet Shelf", "Nora Reader"),
  ];
  books[0].book_series = [{ position: 1, series: { id: 701, name: "The Crossing" } }] as never[];
  const seriesBooks = [
    books[0], book(503, "Crossing Two", "Ada North"), book(504, "Crossing Companion", "Ada North"),
    { ...book(505, "Future Crossing", "Ada North"), release_year: 2999, release_date: "2999-01-01" },
  ];
  const series = [
    { id: 701, name: "The Crossing", books_count: 4, author: { name: "Ada North" },
      book_series: [{ position: 1, book: seriesBooks[0] }, { position: 2, book: seriesBooks[1] },
        { position: null, book: seriesBooks[2] }, { position: 3, book: seriesBooks[3] }] },
    { id: 702, name: "The Crossing", books_count: 1, author: { name: "Bea South" }, book_series: [] },
  ];
  const read = {
    id: 6501,
    started_at: "2026-01-01",
    finished_at: null,
    finished_at_precision: null,
    progress_seconds: 200,
    progress_pages: null,
    edition_id: 9501,
    edition: {
      id: 9501,
      audio_seconds: 21454,
      pages: null,
      reading_format_id: 2,
    },
  };
  const entries = books.map((b, index) => ({
    id: 7501 + index,
    book_id: b.id,
    status_id: index ? 1 : 2,
    updated_at: "2020-01-01T00:00:00Z",
    book: b,
    user_book_reads: index ? [] : [read],
  }));
  let members = books.map((b, index) => ({
    id: 9901 + index,
    list_id: 8803,
    book_id: b.id,
    book: b,
  }));
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith("https://api.hardcover.app/"))
      return original(input, init);
    const { query: q, variables: v } = JSON.parse(String(init?.body));
    let data: unknown;
    if (q.includes("SonderSeriesSearchDetails")) data = { series };
    else if (q.includes("SonderSeriesSearch")) data = { search: { ids: series.map((item) => item.id) } };
    else if (q.includes("SonderSeriesPreview")) data = { series_by_pk: series.find((item) => item.id === v.id) ?? null };
    else if (q.includes("SonderAccount"))
      data = { me: [{ id: 99001, username: "browser-reader" }] };
    else if (q.includes("SonderLibrary"))
      data = { user_books: entries.slice(v.offset, v.offset + 250) };
    else if (q.includes("SonderLists"))
      data = {
        lists: [
          {
            id: 8803,
            user_id: 99001,
            name: "Weekend escapes",
            slug: "weekend-escapes",
            books_count: members.length,
          },
        ],
      };
    else if (q.includes("SonderListBooks")) data = { list_books: members };
    else if (q.includes("SonderListMembership"))
      data = {
        list_books: members.filter(
          (m) => m.list_id === v.list && m.book_id === v.book,
        ),
      };
    else if (q.includes("SonderListRemove")) {
      members = members.filter((m) => m.id !== v.id);
      data = { delete_list_book: { id: v.id } };
    } else if (q.includes("SonderListAdd")) {
      const item = {
        id: 9900 + members.length,
        list_id: v.object.list_id,
        book_id: v.object.book_id,
        book: books.find((b) => b.id === v.object.book_id)!,
      };
      members.push(item);
      data = { insert_list_book: { id: item.id, list_book: item } };
    } else if (q.includes("SonderSearchLinks"))
      data = { books: books.map(({ id, slug }) => ({ id, slug })) };
    else if (q.includes("SonderSearch"))
      data = {
        search: {
          results: JSON.stringify({
            hits: books.map((book) => ({
              document: {
                id: book.id,
                title: book.title,
                author_names: ["Lewis Carroll"],
              },
            })),
          }),
        },
      };
    else if (q.includes("SonderBookProgress"))
      data = { user_books: entries.filter((e) => e.book_id === v.bookId) };
    else if (q.includes("SonderBook("))
      data = { books_by_pk: [...books, ...seriesBooks].find((b) => b.id === v.id) || null };
    else if (q.includes("SonderShelfUpdate")) {
      const item = entries.find((e) => e.id === v.id)!;
      item.status_id = v.object.status_id;
      item.updated_at = new Date().toISOString();
      data = { update_user_book: { error: null, user_book: item } };
    } else if (q.includes("SonderReadProgress")) {
      const item = entries.find((e) =>
        e.user_book_reads.some((r) => r.id === v.id),
      )!;
      const next = { ...item.user_book_reads[0], ...v.object };
      item.user_book_reads = [next];
      item.updated_at = new Date().toISOString();
      data = { update_user_book_read: { error: null, user_book_read: next } };
    } else
      return Response.json({
        errors: [{ message: "Unsupported fixture operation" }],
      });
    return Response.json({ data: structuredClone(data) });
  };
}
