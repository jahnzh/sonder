// Shared by scripts/verify-multi-user.mjs (live) and unit tests.
// Only the admin library membership set plus the QA book row (library + progress)
// are compared; other books' status/progress may change while the owner listens.

/** @typedef {{ id: string, inLibrary: boolean, status: string, progress?: { position: number, updatedAt: number } }} AdminBookRow */

/**
 * @param {AdminBookRow[]} books
 * @param {string} playableBookId
 */
export function adminMultiUserVerifySnapshot(books, playableBookId) {
  const libraryIds = books.filter((b) => b.inLibrary).map((b) => b.id).sort();
  const playable = books.find((b) => b.id === playableBookId);
  if (!playable)
    throw new Error(`Playable book not in admin catalogue: ${playableBookId}`);
  return {
    libraryIds,
    playable: {
      id: playable.id,
      inLibrary: playable.inLibrary,
      status: playable.status,
      progress: playable.progress && {
        position: playable.progress.position,
        updatedAt: playable.progress.updatedAt,
      },
    },
  };
}

/**
 * @param {ReturnType<typeof adminMultiUserVerifySnapshot>} before
 * @param {ReturnType<typeof adminMultiUserVerifySnapshot>} after
 */
export function assertAdminMultiUserVerifyUnchanged(before, after) {
  if (JSON.stringify(before.libraryIds) !== JSON.stringify(after.libraryIds))
    throw new Error("Admin library membership changed during the check");
  if (JSON.stringify(before.playable) !== JSON.stringify(after.playable))
    throw new Error(
      "Admin progress or library row for the QA recording changed during the check",
    );
}
