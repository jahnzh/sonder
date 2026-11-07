import { Loader2, RefreshCw } from "lucide-react";
import type { AlignmentPoolStatus } from "../reading-types";

export function AlignmentPoolStatusView({
  pool,
  refreshing = false,
  onRefresh,
}: {
  pool: AlignmentPoolStatus | null;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  if (!pool) return null;
  return (
    <div data-testid="alignment-pool-status">
      <h3 className="requests-heading">Alignment pool</h3>
      {!pool.enabled ? (
        <small data-testid="alignment-pool-disabled">
          Remote alignment pool is disabled.
        </small>
      ) : (
        <>
          {onRefresh && (
            <div className="settings-inline-actions">
              <button
                type="button"
                className="button subtle"
                disabled={refreshing}
                onClick={onRefresh}
              >
                {refreshing ? (
                  <Loader2 className="spin" size={14} />
                ) : (
                  <RefreshCw size={14} />
                )}{" "}
                Refresh pool
              </button>
            </div>
          )}
          <ul
            className="user-list"
            aria-label="Alignment pool hosts"
            data-testid="alignment-pool-hosts"
          >
            {pool.hosts.map((host) => (
              <li
                key={host.id}
                className="user-row"
                data-testid={`pool-host-${host.id}`}
              >
                <div className="user-row-name">
                  <strong>{host.id}</strong>
                  <span className="quiet-tag">
                    {host.reachable ? "Reachable" : "Unreachable"}
                  </span>
                  <span className="quiet-tag">
                    {host.device
                      ? host.precision
                        ? `${host.device} · ${host.precision}`
                        : host.device
                      : "device unknown"}
                  </span>
                  <span className="quiet-tag">
                    {host.stuck ? "Stuck" : host.busy ? "Busy" : "Idle"}
                  </span>
                </div>
                {host.lastError && (
                  <small
                    className="error-text"
                    data-testid={`pool-host-${host.id}-error`}
                  >
                    Last error: {host.lastError}
                  </small>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
