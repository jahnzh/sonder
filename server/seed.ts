import { db, sqlite } from "./db.ts";
import * as s from "./schema.ts";
import { existsSync, readFileSync } from "node:fs";
import { mediaRoot } from "./storage.ts";
import { join } from "node:path";
export const seedBooks = [
  {
    id: "alice",
    title: "Alice’s Adventures in Wonderland",
    author: "Lewis Carroll",
    narrator: "Kara Shallenberg",
    genre: "Fantasy",
    year: 1865,
    rating: 4.6,
    description:
      "Follow a curious girl down a rabbit hole and into a world where nothing is quite as it seems. A delightfully strange adventure, full of improbable friends, impossible riddles, and a little everyday magic.",
  },
  {
    id: "sherlock",
    title: "The Adventures of Sherlock Holmes",
    author: "Arthur Conan Doyle",
    narrator: "LibriVox volunteers",
    genre: "Mystery",
    year: 1892,
    rating: 4.8,
    description:
      "The game is afoot. Join literature’s most brilliant detective and his steadfast friend Dr. Watson in twelve ingenious mysteries, from the fogbound streets of London to the quiet English countryside.",
  },
  {
    id: "pride",
    title: "Pride and Prejudice",
    author: "Jane Austen",
    narrator: "LibriVox volunteers",
    genre: "Fiction",
    year: 1813,
    rating: 4.7,
    description:
      "Elizabeth Bennet has a quick wit and a mind of her own. Mr. Darcy has a considerable fortune and a rather unfortunate first impression. A timeless comedy of manners, family, and unexpected love.",
  },
  {
    id: "frankenstein",
    title: "Frankenstein",
    author: "Mary Shelley",
    narrator: "LibriVox volunteers",
    genre: "Fiction",
    year: 1818,
    rating: 4.5,
    description:
      "An ambitious young scientist breathes life into a creature he cannot understand. Mary Shelley’s haunting masterpiece asks what it means to be human, and what we owe to the things we create.",
  },
  {
    id: "time",
    title: "The Time Machine",
    author: "H. G. Wells",
    narrator: "LibriVox volunteers",
    genre: "Science fiction",
    year: 1895,
    rating: 4.4,
    description:
      "One extraordinary invention. Eight hundred thousand years. A journey beyond the boundaries of imagination that forever changed how we think about the future.",
  },
  {
    id: "meditations",
    title: "Meditations",
    author: "Marcus Aurelius",
    narrator: "LibriVox volunteers",
    genre: "Mind & life",
    year: 180,
    rating: 4.8,
    description:
      "Quiet reflections from a Roman emperor on living well, meeting adversity, and finding clarity. An enduring companion for a thoughtful life in a noisy world.",
  },
  {
    id: "gatsby",
    title: "The Great Gatsby",
    author: "F. Scott Fitzgerald",
    narrator: "LibriVox volunteers",
    genre: "Fiction",
    year: 1925,
    rating: 4.5,
    description:
      "On the glittering shores of Long Island, a mysterious millionaire pursues an impossible dream. An unforgettable portrait of ambition, reinvention, and the beautiful things we cannot keep.",
  },
  {
    id: "war",
    title: "The Art of War",
    author: "Sun Tzu",
    narrator: "LibriVox volunteers",
    genre: "Mind & life",
    year: -500,
    rating: 4.3,
    description:
      "The ancient art of thinking clearly. Thirteen concise chapters on strategy, patience, and understanding, with insights that reach far beyond the battlefield.",
  },
];
export function seed() {
  if (
    sqlite.prepare("SELECT count(*) AS n FROM works").get() &&
    (sqlite.prepare("SELECT count(*) AS n FROM works").get() as { n: number }).n
  )
    return;
  const catalog = existsSync("server/catalog.json")
    ? JSON.parse(readFileSync("server/catalog.json", "utf8"))
    : {};
  sqlite.transaction(() => {
    seedBooks.forEach((b, i) => {
      db.insert(s.works)
        .values({
          id: `work-${b.id}`,
          title: b.title,
          author: b.author,
          description: b.description,
          genre: b.genre,
          year: b.year,
        })
        .run();
      db.insert(s.editions)
        .values({
          id: b.id,
          workId: `work-${b.id}`,
          cover: `/covers/${b.id}.svg`,
          narrator: b.narrator,
          rating: b.rating,
          sourceLabel: "LibriVox · Public domain",
        })
        .run();
      db.insert(s.recordings)
        .values({ id: `recording-${b.id}`, editionId: b.id })
        .run();
      const list = catalog[b.id] || [];
      list.forEach(
        (t: { title: string; duration: number; url: string }, index: number) =>
          db
            .insert(s.tracks)
            .values({
              id: `${b.id}-${index}`,
              recordingId: `recording-${b.id}`,
              title: t.title,
              index,
              duration: t.duration,
              source:
                b.id === "alice" && index === 0
                  ? join(mediaRoot, "demo", "alice-01.mp3")
                  : t.url,
              sourceType: b.id === "alice" && index === 0 ? "local" : "remote",
            })
            .run(),
      );
      if (i < 6)
        db.insert(s.library)
          .values({
            bookId: b.id,
            status: "unread",
            addedAt: Date.now() - i * 86400000,
          })
          .run();
    });
  })();
}
