import { FolderOpen, Files, Save, Replace, Music, X } from "lucide-react";

interface ToolbarProps {
  onOpenFolder: () => void;
  onOpenFiles: () => void;
  onSave: () => void;
  onRevert: () => void;
  onToggleFindReplace: () => void;
  findReplaceActive: boolean;
  hasFiles: boolean;
  modifiedCount: number;
  busy: boolean;
  /** True while a scan is streaming in; shows a Cancel button. */
  scanning: boolean;
  onCancelScan: () => void;
  /** Filename of the currently focused file, shown so users know what they're editing. */
  currentFile?: string;
}

export function Toolbar(props: ToolbarProps) {
  const hasChanges = props.modifiedCount > 0;
  return (
    <header className="toolbar" role="toolbar" aria-label="Main actions">
      <div className="toolbar-group">
        <button type="button" onClick={props.onOpenFolder} disabled={props.busy}>
          <FolderOpen size={16} aria-hidden="true" /> Open Folder
        </button>
        <button type="button" onClick={props.onOpenFiles} disabled={props.busy}>
          <Files size={16} aria-hidden="true" /> Open Files
        </button>
        {props.scanning && (
          <button type="button" onClick={props.onCancelScan} aria-label="Cancel scan">
            <X size={16} aria-hidden="true" /> Cancel
          </button>
        )}
      </div>
      <div className="toolbar-sep" role="separator" aria-orientation="vertical" />
      <div className="toolbar-group">
        <button
          type="button"
          onClick={props.onToggleFindReplace}
          disabled={!props.hasFiles || props.busy}
          aria-pressed={props.findReplaceActive}
        >
          <Replace size={16} aria-hidden="true" /> Find &amp; Replace
        </button>
      </div>
      <div className="toolbar-sep" role="separator" aria-orientation="vertical" />
      <div className="toolbar-group">
        <button
          type="button"
          className="primary"
          onClick={props.onSave}
          disabled={!hasChanges || props.busy}
        >
          <Save size={16} aria-hidden="true" /> Save
          {hasChanges ? ` (${props.modifiedCount})` : ""}
        </button>
        <button type="button" onClick={props.onRevert} disabled={!hasChanges || props.busy}>
          Revert
        </button>
      </div>
      {props.currentFile && (
        <div className="toolbar-current" title={props.currentFile}>
          <Music size={14} aria-hidden="true" />
          <span className="toolbar-current-name">{props.currentFile}</span>
        </div>
      )}
    </header>
  );
}
