import { useState, useEffect, useRef } from 'react';
import { submitFeedback, analyticsEnabled } from '../analytics.js';

const CATEGORIES = [
  { value: 'bug', label: 'Something broke' },
  { value: 'confusing', label: 'Something was confusing' },
  { value: 'feature', label: 'Feature request' },
  { value: 'other', label: 'Other feedback' },
];

export default function FeedbackModal({ onClose }) {
  const [step, setStep] = useState('category');
  const [category, setCategory] = useState(null);
  const [detail, setDetail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const textRef = useRef(null);

  useEffect(() => {
    if (step === 'detail') {
      textRef.current?.focus();
    }
  }, [step]);

  const handleDetailSubmit = async () => {
    setSubmitFailed(false);
    if (!analyticsEnabled()) {
      setSubmitFailed(true);
      return;
    }
    setSubmitting(true);
    const delivered = await submitFeedback({ category, detail: detail.trim() });
    setSubmitting(false);
    if (delivered) setSubmitted(true);
    else setSubmitFailed(true);
  };

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') onClose();
  };

  if (submitted) {
    return (
      <div
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={handleBackdropClick}
        onKeyDown={handleKeyDown}
        tabIndex={-1}
      >
        <div className="mx-4 w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900 p-6 shadow-2xl text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/20">
            <svg className="h-6 w-6 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          </div>
          <h3 className="text-base font-semibold text-white">Thank you</h3>
          <p className="mt-2 text-sm text-zinc-400">
            Your feedback was sent anonymously and will help improve OpenOpusClips.
          </p>
          <button
            onClick={onClose}
            className="mt-5 w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div className="mx-4 w-full max-w-sm rounded-xl border border-white/10 bg-zinc-900 p-6 shadow-2xl">
        {step === 'category' && (
          <>
            <h3 className="text-base font-semibold text-zinc-100">What best describes your feedback?</h3>
            <div className="mt-3 space-y-2">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  onClick={() => { setCategory(cat.value); setStep('detail'); }}
                  className="w-full rounded-lg border border-white/10 bg-zinc-800/50 px-4 py-2.5 text-left text-sm text-zinc-300 hover:border-primary/50 hover:bg-zinc-800 transition-colors"
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </>
        )}

        {step === 'detail' && (
          <>
            <h3 className="text-base font-semibold text-zinc-100">What were you trying to do?</h3>
            <p className="mt-1 text-xs text-zinc-500">
              Please do not include API keys, private video links, or other sensitive content.
            </p>
            <textarea
              ref={textRef}
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              rows={4}
              maxLength={2000}
              placeholder="What happened instead?"
              className="mt-3 w-full resize-none rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
            {submitFailed && (
              <p className="mt-2 text-xs text-red-400" role="alert">
                Feedback did not reach PostHog. Check your connection and try again.
              </p>
            )}
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => setStep('category')}
                className="flex-1 rounded-lg border border-white/10 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-700 transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleDetailSubmit}
                disabled={submitting}
                className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary/90 transition-colors disabled:cursor-wait disabled:opacity-60"
              >
                {submitting ? 'Sending…' : 'Send feedback'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
