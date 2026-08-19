import { Component, StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { PostHogProvider } from '@posthog/react'
import './index.css'
import App from './App.jsx'
import Legal from './Legal.jsx'
import EditorView from './components/editor/EditorView.jsx'
import ResultCard from './components/ResultCard.jsx'
import FeedbackModal from './components/FeedbackModal.jsx'
import { analyticsClient, analyticsRuntime, captureError, initAnalytics, track, trackPageview } from './analytics.js'

const buildDevTranscript = (items) => {
  let t = 0;
  const words = [];
  items.forEach((item) => {
    if (typeof item === 'number') {
      t += Math.max(0, item * 1000 - 80);
      return;
    }
    const word = typeof item === 'string' ? { text: item } : item;
    const duration = Math.max(180, Math.min(520, word.text.length * 42 + 120));
    words.push({
      text: word.text,
      startMs: Math.round(t),
      endMs: Math.round(t + duration),
      emoji: word.emoji,
      highlight: word.highlight,
    });
    t += duration + 80;
  });
  return words;
};

const TEST_TRANSCRIPT = buildDevTranscript([
  "It's", 0.46, 'just', 'what', 'I', 'need', 0.34,
  { text: 'Something', highlight: true }, 'like', 'this', "doesn't", { text: 'exist', highlight: true }, { text: 'anywhere', highlight: true },
  'in', 'the', 'world', 'where', 0.42, 'young', 0.82,
  { text: 'Muslim', highlight: true }, 'practicing', 'brothers', 'who', 'are', 'also', { text: 'successful', highlight: true },
  'in', 'their', 'own', 'careers', 'come', { text: 'together', highlight: true }, 0.78,
  { text: 'share', highlight: true }, { text: 'insights', highlight: true }, 'work', { text: 'together', highlight: true },
  0.34, 'It', "doesn't", { text: 'happen', highlight: true }, 'anywhere', "it's", 'not', 'something', "that's",
  { text: 'available', highlight: true }, 'anywhere', 'in', 'the', 'world', 'So', 'this', 'has', 'been',
  { text: 'amazing', highlight: true, emoji: '🔥' }, 0.4, { text: 'meeting', highlight: true }, 'with', 'a', 'lot',
  'of', 'brothers', 'from', 0.5, 'all', { text: 'corners', highlight: true }, 'of', 'the', 'world',
  { text: 'connecting', highlight: true }, 'with', 'them', 0.28, 'possibly', 'doing', 'some',
  { text: 'business', highlight: true },
]);

// Dev harness: open /?editorDev=1 to mount the clip editor against local
// fixtures in dashboard/public/dev-fixtures/ (gitignored). Lets you work on the
// editor without processing a job first.
// Default (`static`) uses the user's real test clip (test-source.mp4 +
// test.framing.json — a 45s 1080p proxy of the Dubai network video, mixed
// layouts so layout-switch behavior can be exercised). `?editorDev=demo` falls
// back to the original demo fixture.
// /?editorDev=backend instead serves the fixture through the API (expects
// output/dev/demo_clip_1_source.mp4 + demo_clip_1.framing.json on the
// backend) so Save and Export can be exercised end-to-end.
const EDITOR_DEV_FIXTURES = {
  static: {
    framing_url: '/dev-fixtures/test.framing.json',
    source_url: '/dev-fixtures/test-source.mp4',
    video_title_for_youtube_short: 'Test clip (Dubai network)',
    transcript_captions: TEST_TRANSCRIPT,
  },
  demo: {
    framing_url: '/dev-fixtures/demo.framing.json',
    source_url: '/dev-fixtures/demo-source.mp4',
    video_title_for_youtube_short: 'Editor dev fixture',
  },
  backend: {
    framing_url: '/videos/dev/demo_clip_1.framing.json',
    source_url: '/videos/dev/demo_clip_1_source.mp4',
    video_url: '/videos/dev/demo_clip_1_source.mp4',
    video_title_for_youtube_short: 'Editor dev fixture (backend)',
    // Where the fixture clip sits in its "original" video — anchors the
    // transcript panel's "+" extend bars in dev.
    start: 0,
    end: 45,
  },
};

// Dev harness: open /?cardDev=1 to mount a single results-grid clip card
// against the local fixture, with the transcript API stubbed — lets you work
// on the card preview (default captions, detail modal) without processing a
// job. Pairs with ?editorDev=1 below.
let transcriptFetchStubbed = false;
function stubTranscriptFetch() {
  if (transcriptFetchStubbed) return;
  transcriptFetchStubbed = true;
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, ...rest) =>
    typeof url === 'string' && url.includes('/api/clip/')
      ? Promise.resolve(new Response(
          JSON.stringify({ captions: TEST_TRANSCRIPT, durationSec: 45 }),
          { headers: { 'Content-Type': 'application/json' } }
        ))
      : realFetch(url, ...rest);
}

function CardDevHarness() {
  const [openIndex, setOpenIndex] = useState(null);
  const clip = {
    ...EDITOR_DEV_FIXTURES.static,
    video_url: EDITOR_DEV_FIXTURES.static.source_url,
    start: 0,
    end: 45,
  };
  return (
    <div style={{ width: 280, margin: '40px auto' }}>
      <ResultCard clip={clip} index={0} jobId="dev" openIndex={openIndex} setOpenIndex={setOpenIndex} />
    </div>
  );
}

/** Loads a real processed clip from the status API and opens the editor on it. */
function EditorJobLoader({ jobId, clipIndex, onClose }) {
  const [clip, setClip] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    fetch(`/api/status/${jobId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((d) => {
        const clips = d?.result?.clips || [];
        if (!clips[clipIndex]) throw new Error('clip not found in job');
        setClip(clips[clipIndex]);
      })
      .catch((e) => setError(e.message));
  }, [jobId, clipIndex]);
  if (error) return <div style={{ color: '#fff', padding: 24 }}>Failed to load clip: {error}</div>;
  if (!clip) return <div style={{ color: '#fff', padding: 24 }}>Loading clip…</div>;
  return <EditorView clip={clip} index={clipIndex} jobId={jobId} onClose={onClose} />;
}

function Root() {
  const resolveView = () => {
    const hash = window.location.hash;
    if (hash === '#legal') return 'legal';
    // The app opens straight on the dashboard. #trailer is a legacy deep
    // link — App reads the hash itself to open on that tab.
    return 'app';
  };

  const [view, setView] = useState(resolveView);

  useEffect(() => {
    track('view_changed', { view });
    trackPageview(view);
  }, [view]);

  useEffect(() => {
    const handleHashChange = () => setView(resolveView());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const params = new URLSearchParams(window.location.search);
  const editorDevMode = params.get('editorDev');
  if (editorDevMode) {
    return (
      <EditorView
        clip={EDITOR_DEV_FIXTURES[editorDevMode] || EDITOR_DEV_FIXTURES.static}
        index={0}
        jobId="dev"
        onClose={() => window.location.assign(window.location.pathname)}
      />
    );
  }
  // Card preview dev harness: /?cardDev=1 (see CardDevHarness above)
  if (params.get('cardDev')) {
    stubTranscriptFetch();
    return <CardDevHarness />;
  }
  // Open the editor on a real processed clip: /?editorJob=<jobId>&clip=<index>
  const editorJob = params.get('editorJob');
  if (editorJob) {
    return (
      <EditorJobLoader
        jobId={editorJob}
        clipIndex={Number(params.get('clip') || 0)}
        onClose={() => window.location.assign(window.location.pathname)}
      />
    );
  }
  if (view === 'legal') return <Legal />;
  return <App />;
}

function FeedbackButton() {
  const [showModal, setShowModal] = useState(false);
  return (
    <>
    <button
      id="app-feedback-button"
      type="button"
      data-tour="feedback-button"
      className="fixed bottom-4 right-4 z-[100] rounded-lg border border-white/10 bg-zinc-900/95 px-3 py-2 text-xs font-medium text-zinc-300 shadow-lg hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-primary"
        onClick={() => setShowModal(true)}
      >
        Feedback
      </button>
      {showModal && <FeedbackModal onClose={() => setShowModal(false)} />}
    </>
  );
}

class AppErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    captureError(error, { area: 'react_boundary' });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-zinc-950 px-6 text-center text-white">
          <div>
            <h1 className="text-lg font-semibold">Something went wrong</h1>
            <p className="mt-2 text-sm text-zinc-400">Refresh the app and try again.</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-5 rounded-lg bg-primary px-4 py-2 text-sm font-medium"
            >
              Refresh app
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

async function renderApp() {
  await initAnalytics();
  track('app_opened', { runtime: analyticsRuntime() });

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <PostHogProvider client={analyticsClient}>
        <AppErrorBoundary>
          <Root />
        </AppErrorBoundary>
        <FeedbackButton />
      </PostHogProvider>
    </StrictMode>,
  );
}

renderApp();
