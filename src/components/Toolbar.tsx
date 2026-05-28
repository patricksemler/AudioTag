interface ToolbarProps {
  onOpenFolder: () => void;
  onOpenFiles: () => void;
  onSave: () => void;
  onRevert: () => void;
  modifiedCount: number;
  busy: boolean;
}

export function Toolbar(props: ToolbarProps) {
  const hasChanges = props.modifiedCount > 0;
  return (
    <header className="toolbar" role="toolbar" aria-label="Main actions">
      <div className="toolbar-group">
        <button type="button" onClick={props.onOpenFolder} disabled={props.busy}>
          <span aria-hidden="true">📂</span> Open Folder
        </button>
        <button type="button" onClick={props.onOpenFiles} disabled={props.busy}>
          <span aria-hidden="true">📄</span> Open Files
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
          <span aria-hidden="true">💾</span> Save
          {hasChanges ? ` (${props.modifiedCount})` : ""}
        </button>
        <button type="button" onClick={props.onRevert} disabled={!hasChanges || props.busy}>
          Revert
        </button>
      </div>
    </header>
  );
}
