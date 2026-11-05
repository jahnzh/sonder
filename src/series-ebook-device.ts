/** Map server ebook edition ids to offline-on-device state from Dexie reader-file keys. */
export function workEbookOnDevice(
  editionIds: string[] | undefined,
  offlineEbookEditionIds: ReadonlySet<string>,
): boolean {
  if (!editionIds?.length) return false;
  return editionIds.some((id) => offlineEbookEditionIds.has(id));
}

export function formatEbookDeviceSuffix(onDevice: boolean): string {
  return onDevice ? " · on device" : " · not on device";
}
