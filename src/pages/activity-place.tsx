// Activity as a place (#516, spec #513 "The place, addresses and navigation"; boards Activity.dc.html,
// ActivityMember.dc.html, DesktopActivity.dc.html): the Page header and the Segmented control of its parts. Until
// their own tickets land the parts show what exists: Now is today's Downloads page, Server today's Activity page.
// This device is everyone's (#518, `activity-device.tsx`).
import type { ReactNode } from "react";
import type { ActivityPart } from "../routes";
import { PageHeader } from "../parts/PageHeader";
import { Segmented, type SegmentOption } from "../parts/Segmented";

/** The parts this user has: Server is the administrator's. */
export function activityParts(admin: boolean): SegmentOption<ActivityPart>[] {
  return admin
    ? [
        { value: "now", label: "Now" },
        { value: "device", label: "This device" },
        { value: "server", label: "Server" },
      ]
    : [
        { value: "now", label: "Now" },
        { value: "device", label: "This device" },
      ];
}

export function ActivityPlace({
  admin,
  part,
  onPart,
  now,
  device,
  server,
}: {
  admin: boolean;
  /** The part the address names; routes.ts already turned Server into Now for someone who is not the administrator. */
  part: ActivityPart;
  /** Switching parts replaces the address (ADR 0020): the shell moves there. */
  onPart: (part: ActivityPart) => void;
  now: ReactNode;
  device: ReactNode;
  server: ReactNode;
}) {
  const parts = activityParts(admin);
  const shown = parts.some((option) => option.value === part) ? part : "now";
  return (
    <>
      <div style={{ display: "grid", gap: "var(--space-16)", marginBottom: "var(--space-24)" }}>
        <PageHeader title="Activity" />
        {/* One part alone is nothing to choose between. */}
        {parts.length > 1 && <Segmented label="Activity" options={parts} value={shown} onChange={onPart} />}
      </div>
      {shown === "server" ? server : shown === "device" ? device : now}
    </>
  );
}
