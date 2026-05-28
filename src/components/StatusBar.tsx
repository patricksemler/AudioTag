import { Circle } from "lucide-react";

interface StatusBarProps {
  total: number;
  selected: number;
  modified: number;
  message: string;
}

export function StatusBar({ total, selected, modified, message }: StatusBarProps) {
  return (
    <footer className="status-bar">
      <span>{total} files</span>
      <span>·</span>
      <span>{selected} selected</span>
      {modified > 0 && (
        <>
          <span>·</span>
          <span className="status-modified">
            <Circle size={8} fill="currentColor" aria-hidden="true" /> {modified} unsaved
          </span>
        </>
      )}
      {/* Live region announces async results to screen readers. */}
      <span className="status-message" role="status" aria-live="polite">
        {message}
      </span>
    </footer>
  );
}
