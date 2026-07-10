import React from 'react';
import { ArrowLeft, Save, Upload, Loader2, Undo2, Redo2 } from 'lucide-react';

/** OpusClip-style top bar: quiet chrome, strong Export, clear title. */
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
        <div className="h-12 shrink-0 border-b border-white/[0.06] bg-[#0c0c0e] flex items-center gap-2 px-3">
            <button
                type="button"
                onClick={onBack}
                className="w-8 h-8 rounded-lg flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
                aria-label="Back to clips"
            >
                <ArrowLeft size={17} />
            </button>
            <h1 className="text-[13px] font-medium text-zinc-100 truncate min-w-0 mr-1 tracking-tight">
                {title}
                {dirty && (
                    <span className="ml-2 inline-block w-1.5 h-1.5 rounded-full bg-viral align-middle" title="Unsaved changes" />
                )}
            </h1>

            <div className="flex items-center gap-px mr-1 rounded-lg border border-white/[0.06] overflow-hidden">
                <button
                    type="button"
                    onClick={onUndo}
                    disabled={!canUndo}
                    title="Undo (⌘Z)"
                    className="w-8 h-8 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    aria-label="Undo"
                >
                    <Undo2 size={15} />
                </button>
                <span className="w-px h-4 bg-white/10" />
                <button
                    type="button"
                    onClick={onRedo}
                    disabled={!canRedo}
                    title="Redo (⇧⌘Z)"
                    className="w-8 h-8 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    aria-label="Redo"
                >
                    <Redo2 size={15} />
                </button>
            </div>

            <div className="ml-auto flex items-center gap-2">
                <button
                    type="button"
                    onClick={onSave}
                    disabled={!dirty || saving || !onSave}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.04] text-zinc-200 border border-white/[0.08] hover:bg-white/[0.08] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                    Save changes
                </button>
                <button
                    type="button"
                    onClick={onExport}
                    disabled={exporting || !onExport}
                    className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-white text-black hover:bg-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm"
                >
                    {exporting ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                    {exporting ? `Exporting ${exportProgress ?? 0}%` : 'Export'}
                </button>
            </div>
        </div>
    );
}
