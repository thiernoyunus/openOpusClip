import React from 'react';
import { ArrowLeft, Save, Upload, Loader2, Undo2, Redo2 } from 'lucide-react';

export default function EditorTopBar({
    title,
    dirty,
    saving,
    exporting,
    exportProgress,
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    onBack,
    onSave,
    onExport,
}) {
    return (
        <div className="h-12 shrink-0 border-b border-edge bg-surface flex items-center gap-2 px-3">
            <button
                onClick={onBack}
                className="w-8 h-8 rounded-md flex items-center justify-center text-muted hover:text-fg hover:bg-white/5 transition-colors"
                aria-label="Back to clips"
            >
                <ArrowLeft size={17} />
            </button>
            <h1 className="text-[13px] font-medium text-fg truncate min-w-0 mr-1">
                {title}
                {dirty && (
                    <span className="ml-2 inline-block w-1.5 h-1.5 rounded-full bg-viral align-middle" title="Unsaved changes" />
                )}
            </h1>

            {/* Undo / redo as a tight grouped pair */}
            <div className="flex items-center gap-px mr-1">
                <button
                    onClick={onUndo}
                    disabled={!canUndo}
                    title="Undo (⌘Z)"
                    className="w-8 h-8 rounded-l-md flex items-center justify-center text-muted hover:text-fg hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    aria-label="Undo"
                >
                    <Undo2 size={15} />
                </button>
                <span className="w-px h-4 bg-edge" />
                <button
                    onClick={onRedo}
                    disabled={!canRedo}
                    title="Redo (⇧⌘Z)"
                    className="w-8 h-8 rounded-r-md flex items-center justify-center text-muted hover:text-fg hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    aria-label="Redo"
                >
                    <Redo2 size={15} />
                </button>
            </div>

            <div className="ml-auto flex items-center gap-2">
                <button
                    onClick={onSave}
                    disabled={!dirty || saving || !onSave}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-surface2 text-fg border border-edge hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                    Save
                </button>
                <button
                    onClick={onExport}
                    disabled={exporting || !onExport}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium bg-fg text-[#18181b] hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    {exporting ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                    {exporting ? `Exporting ${exportProgress ?? 0}%` : 'Export'}
                </button>
            </div>
        </div>
    );
}
