import React from 'react';
import { ArrowLeft, Save, Loader2, Undo2, Redo2 } from 'lucide-react';

/**
 * Top bar: [← Title] ........ [Undo Redo] [Save changes] [Export]
 */
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
        <header className="h-[48px] shrink-0 bg-[#0b0b0d] border-b border-white/[0.05] flex items-center px-3 gap-2">
            <button
                type="button"
                onClick={onBack}
                className="w-8 h-8 rounded-md flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/[0.06] transition-colors"
                aria-label="Back to clips"
            >
                <ArrowLeft size={18} strokeWidth={1.75} />
            </button>

            <h1 className="ph-mask text-[13px] font-medium text-zinc-200 truncate max-w-[min(42vw,420px)] tracking-[-0.01em]">
                {title}
                {dirty && (
                    <span
                        className="ml-2 inline-block w-1.5 h-1.5 rounded-full bg-[#3dd68c] align-middle"
                        title="Unsaved changes"
                    />
                )}
            </h1>

            <div className="ml-auto flex items-center gap-1.5">
                <button
                    type="button"
                    onClick={onUndo}
                    disabled={!canUndo}
                    title="Undo (⌘Z)"
                    className="w-8 h-8 rounded-md flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/[0.06] disabled:opacity-25 disabled:cursor-not-allowed"
                    aria-label="Undo"
                >
                    <Undo2 size={16} strokeWidth={1.75} />
                </button>
                <button
                    type="button"
                    onClick={onRedo}
                    disabled={!canRedo}
                    title="Redo (⇧⌘Z)"
                    className="w-8 h-8 rounded-md flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/[0.06] disabled:opacity-25 disabled:cursor-not-allowed"
                    aria-label="Redo"
                >
                    <Redo2 size={16} strokeWidth={1.75} />
                </button>

                <button
                    type="button"
                    onClick={onSave}
                    disabled={!dirty || saving || !onSave}
                    className="ml-1 h-8 px-3.5 rounded-lg text-[12px] font-medium text-zinc-200 bg-white/[0.06] border border-white/[0.08] hover:bg-white/[0.1] disabled:opacity-35 disabled:cursor-not-allowed transition-colors"
                >
                    {saving ? (
                        <span className="inline-flex items-center gap-1.5">
                            <Loader2 size={13} className="animate-spin" /> Saving…
                        </span>
                    ) : (
                        <span className="inline-flex items-center gap-1.5">
                            <Save size={13} className="opacity-70" /> Save changes
                        </span>
                    )}
                </button>

                <button
                    type="button"
                    onClick={onExport}
                    disabled={exporting || !onExport}
                    className="h-8 px-4 rounded-lg text-[12px] font-semibold bg-white text-black hover:bg-zinc-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                    {exporting ? (
                        <span className="inline-flex items-center gap-1.5">
                            <Loader2 size={13} className="animate-spin" /> {exportProgress ?? 0}%
                        </span>
                    ) : (
                        'Export'
                    )}
                </button>
            </div>
        </header>
    );
}
