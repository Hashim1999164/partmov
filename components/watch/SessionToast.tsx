"use client";

type Props = {
  message: string | null;
  tone?: "info" | "warn";
  onDismiss?: () => void;
};

export function SessionToast({ message, tone = "info", onDismiss }: Props) {
  if (!message) return null;
  return (
    <div className={`session-toast session-toast--${tone}`} role="status">
      <p>{message}</p>
      {onDismiss && (
        <button type="button" className="session-toast__x" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      )}
    </div>
  );
}
