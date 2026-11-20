// A test-only route (never registered by the production server) for #763's browser spec: the owner's data shape on
// production, written as rows. A Game of Thrones has its catalogue placeholder `hc-644` with a real cover (an uploaded
// image the server serves) and two TorBox editions stored with The Time Machine's art (`/covers/time.svg`), the newest
// place in the second; Dangerous Women has only a catalogue placeholder stored with Meditations' art.
import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const COVER_SHAPE_FIXTURE = "/api/__fixture/cover-shape";
export const COVER_SHAPE_IMAGE = "/api/covers/0763c0de0763c0de0763c0de0763c0de.png";
// A 2x3 PNG, red.
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000002000000030802000000368849d60000001049444154789c6338606000440c2814004a5506c1a837df340000000049454e44ae426082",
  "hex",
);

export function registerCoverFixtureRoutes(app: FastifyInstance) {
  app.post(COVER_SHAPE_FIXTURE, async (req) => {
    const { currentUserId } = await import("../server/users.ts");
    const { sqlite } = await import("../server/db.ts");
    const { mediaRoot } = await import("../server/storage.ts");
    const userId = currentUserId(req);
    mkdirSync(join(mediaRoot, "covers"), { recursive: true });
    writeFileSync(join(mediaRoot, "covers", COVER_SHAPE_IMAGE.split("/").pop()!), PNG);
    const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
    const work = (id: string, title: string) =>
      run("INSERT INTO works(id,title,author,description,genre,year) VALUES(?,?,'George R.R. Martin','','Fantasy',1996) ON CONFLICT DO NOTHING", id, title);
    const edition = (id: string, workId: string, cover: string, tracks: boolean) => {
      run(
        "INSERT INTO audio_editions(id,work_id,cover,narrator,language,release_title,rating,source_label) VALUES(?,?,?,'Roy Dotrice','en',NULL,0,'TorBox') ON CONFLICT DO NOTHING",
        id, workId, cover,
      );
      run("INSERT INTO recordings(id,edition_id) VALUES(?,?) ON CONFLICT DO NOTHING", `recording-${id}`, id);
      if (tracks)
        run(
          "INSERT INTO tracks(id,recording_id,title,track_index,duration,source,source_type,chapters) VALUES(?,?,'Part 1',0,600,?,'remote','[]') ON CONFLICT DO NOTHING",
          `${id}-t1`, `recording-${id}`, `https://audio.invalid/${id}.mp3`,
        );
      run("INSERT INTO user_library(user_id,book_id,status,added_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING", userId, id, tracks ? "listening" : "unread", Date.now());
    };
    work("w-got-763", "A Game of Thrones");
    edition("hc-644", "w-got-763", COVER_SHAPE_IMAGE, false);
    edition("torbox-144379929", "w-got-763", "/covers/time.svg", true);
    edition("torbox-150169001", "w-got-763", "/covers/time.svg", true);
    run(
      "INSERT INTO user_progress(user_id,recording_id,track_id,position,duration,updated_at) VALUES(?,?,?,30,600,?) ON CONFLICT DO NOTHING",
      userId, "recording-torbox-150169001", "torbox-150169001-t1", Date.now(),
    );
    work("w-dw-763", "Dangerous Women");
    edition("placeholder-work-abdb-dw", "w-dw-763", "/covers/meditations.svg", false);
    return { ok: true };
  });
}
