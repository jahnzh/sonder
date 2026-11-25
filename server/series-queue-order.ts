// The series queue's order (ADR 0010, #898), pure so the Activity source can read it without opening the database:
// a job the owner moved to the front (Search now) first, the latest such first; then the oldest row first. `alias` is
// the table's name in a query that joins it ("j").
export function seriesQueueOrder(alias = "") {
  const column = (name: string) => (alias ? `${alias}.${name}` : name);
  return `${column("front_at")} IS NULL, ${column("front_at")} DESC, ${column("rowid")}`;
}
