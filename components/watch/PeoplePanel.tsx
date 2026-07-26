"use client";

import { initials, type ControlMode, type PartnerState, type Role } from "@/lib/sync-protocol";

type Props = {
  role: Role;
  name: string;
  color: string;
  partnerName: string | null;
  partnerColor: string;
  partnerState: PartnerState;
  selfReady: boolean;
  partnerReady: boolean;
  controlMode: ControlMode;
  remoteHolder: Role;
  controlRequested: boolean;
  onSetMode: (mode: ControlMode, holder?: Role) => void;
  onRequestControl: () => void;
  onApproveControl: () => void;
  onDenyControl: () => void;
};

export function PeoplePanel({
  role,
  name,
  color,
  partnerName,
  partnerColor,
  partnerState,
  selfReady,
  partnerReady,
  controlMode,
  remoteHolder,
  controlRequested,
  onSetMode,
  onRequestControl,
  onApproveControl,
  onDenyControl,
}: Props) {
  const isHost = role === "host";
  const guestLabel = partnerName || "guest";
  const holderLabel =
    controlMode === "shared"
      ? "Both of you"
      : remoteHolder === "host"
        ? isHost
          ? "You (host)"
          : partnerName || "Host"
        : isHost
          ? guestLabel
          : "You";

  return (
    <div className="rail-panel">
      <h3>People</h3>

      <ul className="people-list">
        <li>
          <span className="people-avatar" style={{ background: color }}>
            {initials(name)}
          </span>
          <div>
            <strong>
              {name} · {role}
            </strong>
            <span>{selfReady ? "Ready" : "Buffering"} · you</span>
          </div>
        </li>
        <li>
          <span className="people-avatar" style={{ background: partnerColor }}>
            {partnerName ? initials(partnerName) : "?"}
          </span>
          <div>
            <strong>
              {partnerName ?? "Waiting…"} · {role === "host" ? "guest" : "host"}
            </strong>
            <span>
              {partnerState}
              {partnerName ? (partnerReady ? " · ready" : " · buffering") : ""}
            </span>
          </div>
        </li>
      </ul>

      <p className="rail-panel__muted">Remote holder: {holderLabel}</p>

      {isHost ? (
        <div className="stack stack--sm">
          <button
            type="button"
            className={`btn btn--ghost${controlMode === "host_only" ? " is-active-control" : ""}`}
            onClick={() => onSetMode("host_only", "host")}
          >
            You hold the remote
          </button>
          <button
            type="button"
            className={`btn btn--ghost${controlMode === "shared" ? " is-active-control" : ""}`}
            onClick={() => onSetMode("shared")}
          >
            Share control with both
          </button>
          <button
            type="button"
            className={`btn btn--ghost${controlMode === "handed_to_guest" ? " is-active-control" : ""}`}
            disabled={!partnerName}
            onClick={() => onSetMode("handed_to_guest", "guest")}
          >
            Give remote to {guestLabel}
          </button>
          {controlRequested && (
            <div className="people-request">
              <p>{guestLabel} asked for the remote</p>
              <button type="button" className="btn btn--primary" onClick={onApproveControl}>
                Give it to them
              </button>
              <button type="button" className="btn btn--ghost" onClick={onDenyControl}>
                Keep it
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="stack stack--sm">
          {controlMode === "handed_to_guest" || controlMode === "shared" ? (
            <p className="rail-panel__muted">
              {controlMode === "shared" ? "You share the remote with the host." : "You hold the remote."}
            </p>
          ) : (
            <button type="button" className="btn btn--ghost" onClick={onRequestControl}>
              Request the remote
            </button>
          )}
        </div>
      )}
    </div>
  );
}
