import { StrictMode, useState, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import Landing from './Landing.jsx'
import Legal from './Legal.jsx'
import EditorView from './components/editor/EditorView.jsx'

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
  },
};

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
    if (hash === '#app' || localStorage.getItem('openshorts_skip_landing') === '1') return 'app';
    return 'landing';
  };

  const [view, setView] = useState(resolveView);

  useEffect(() => {
    const handleHashChange = () => setView(resolveView());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const handleLaunchApp = () => {
    localStorage.setItem('openshorts_skip_landing', '1');
    window.location.hash = '#app';
    setView('app');
  };

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
  if (view === 'app') return <App />;
  return <Landing onLaunchApp={handleLaunchApp} />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
