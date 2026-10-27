import { Smartphone, HardDrive, Cloud } from "lucide-react";
import { usePlayer } from "../player";
export function PlaybackSource({ compact = false }: { compact?: boolean }) {
  const { source } = usePlayer();
  if (!source) return null;
  const label = {
    device: "Device cache",
    server: "Host server",
    torbox: "TorBox",
    remote: "Online stream",
  }[source];
  const Icon =
    source === "device" ? Smartphone : source === "server" ? HardDrive : Cloud;
  const description = {
    device: "Playing a copy stored in this browser",
    server: "Playing audio saved on your host server",
    torbox: "Streaming TorBox audio through your host server",
    remote: "Streaming the source website through your host server",
  }[source];
  return (
    <span
      className={`playback-source ${compact ? "compact" : ""}`}
      aria-label="Playback source"
      role="status"
      title={description}
    >
      <Icon size={compact ? 10 : 13} />
      <span>{compact ? label : `Source: ${label}`}</span>
    </span>
  );
}
