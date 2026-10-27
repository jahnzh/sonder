export function isCompleteMediaResponse(response: Response) {
  if (response.status === 200) return true;
  if (response.status !== 206) return false;
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(
    response.headers.get("content-range") || "",
  );
  if (
    !range ||
    Number(range[1]) !== 0 ||
    Number(range[2]) + 1 !== Number(range[3])
  )
    return false;
  const length = response.headers.get("content-length");
  return length === null || Number(length) === Number(range[3]);
}
export function retryDelayFromHeader(value: string | null, fallback = 1000) {
  const seconds = value === null ? NaN : Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value || "") - Date.now();
  return Number.isFinite(milliseconds)
    ? Math.min(60000, Math.max(0, milliseconds))
    : fallback;
}
