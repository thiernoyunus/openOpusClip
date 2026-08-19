import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import { track } from '../analytics.js';

// One guided flow: app -> settings (Gemini key) -> results -> editor. The
// phase is stored in localStorage so it survives reloads. Ending a phase's
// tour arms the next one; closing a tour early (x / Esc / overlay click)
// stops the whole flow.
const PHASE_KEY = 'openshorts_tour_phase';
const NEXT = { app: 'results', settings: 'results', calendar: 'app', results: 'editor', editor: null };

export const getPhase = () => localStorage.getItem(PHASE_KEY);
export const setPhase = (phase) => localStorage.setItem(PHASE_KEY, phase);
export const clearPhase = () => localStorage.removeItem(PHASE_KEY);

let activeDriver = null;
let runningPhase = null;

// Notification channel so React components re-render when the tour starts
// or stops. Components needing tour-only UI subscribe via subscribeTour and
// read isTourActive (see useTourActive.js).
const listeners = new Set();
function setRunningPhase(value) {
  runningPhase = value;
  listeners.forEach((l) => l());
}
export const subscribeTour = (cb) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

// True while any tour step is on screen. Screens use this to unlock things
// for the tour that normally require real input first (e.g. showing the
// clip options before a YouTube link is pasted).
export const isTourActive = () => runningPhase !== null;

// Moves the flow to the next phase, but only if that phase is the one armed.
// Used by the "Edit clip" button: it knows the user is leaving the current
// screen, so the next screen's tour takes over.
export const armNext = (from) => {
  if (getPhase() !== from) return;
  const next = NEXT[from];
  if (next) setPhase(next);
  else clearPhase();
};

// Restart the walkthrough from the top. The app always opens on the
// dashboard, so this just arms the app phase and reloads to pick it up.
export const startTourFromHome = () => {
  stopTour();
  setPhase('app');
  // Clear the legacy trailer deep-link so the reload lands on the dashboard,
  // where the dashboard tour's targets live. (Trailer targets don't exist on
  // the trailer view, so starting the tour there would degrade it.)
  if (window.location.hash === '#trailer') {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  window.location.reload();
};

// Tears down any active tour without clearing the armed phase (so the tour
// can resume on the next screen). onDestroyed is suppressed by clearing
// runningPhase first.
export const stopTour = () => {
  if (!activeDriver) return;
  setRunningPhase(null);
  activeDriver.destroy();
  activeDriver = null;
};

// Runs the tour for a phase, but only when that phase is armed. Safe to call
// repeatedly (React StrictMode double-mounts in dev): a stale driver is
// destroyed first, and the phase is only consumed when the tour ends.
export const runTourPhase = (phase, opts = {}) => {
  if (getPhase() !== phase) return;
  stopTour();
  setRunningPhase(phase);
  track('tour_started', { phase });
  activeDriver = driver({
    steps: STEPS[phase],
    overlayColor: '#000000',
    overlayOpacity: 0.85,
    stagePadding: 10,
    stageRadius: 10,
    showProgress: true,
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Got it',
    onDoneClick: () => {
      // Custom onDoneClick disables driver.js's default teardown; we destroy
      // explicitly here so the overlay doesn't linger after Done.
      stopTour();
      track('tour_finished', { phase });
      if (opts.onDone) opts.onDone();
      else armNext(phase);
    },
    onCloseClick: () => {
      // Same: custom onCloseClick disables default teardown, so destroy here.
      stopTour();
      track('tour_skipped', { phase });
      clearPhase();
    },
    onDestroyed: () => {
      // Esc / overlay click also destroy the tour without onCloseClick.
      if (runningPhase !== phase) return;
      setRunningPhase(null);
      if (getPhase() === phase) {
        track('tour_skipped', { phase });
        clearPhase();
      }
    },
  });
  activeDriver.drive(opts.startIndex ?? 0);
};

const appSteps = [
  {
    element: 'button[aria-label="Clip Generator"]',
    popover: {
      title: 'The menu',
      description:
        "This sidebar is the app's menu. You're on Clip Generator, where long videos become short clips.",
      side: 'right',
    },
  },
  {
    element: '[data-tour="media-input"]',
    popover: {
      title: 'Start here',
      description:
        'Paste a YouTube link or upload a video. This is the heart of the app — everything starts from this box.',
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="option-ai-clipping"]',
    popover: {
      title: 'AI clipping',
      description:
        "This is the AI's job: it watches the whole video and picks the moments most likely to take off on TikTok, Reels, and Shorts, then turns each one into its own clip.",
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="option-dont-clip"]',
    popover: {
      title: "Don't clip",
      description:
        "Prefer the whole video as one piece? This skips the moment-finding and keeps it whole — captions and reframing still apply.",
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="option-aspect-ratio"]',
    popover: {
      title: 'Aspect ratio',
      description:
        "The shape of your clips. 9:16 is the tall format used by TikTok, Reels, and Shorts.",
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="option-clip-length"]',
    popover: {
      title: 'Clip length',
      description:
        'How long each clip should be. Auto lets the AI pick based on the moment.',
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="option-moments"]',
    popover: {
      title: 'Include specific moments',
      description:
        "Optional: tell the AI what you care about — like 'find moments where we talk about pricing' — and it will prioritise those.",
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="caption-style"]',
    popover: {
      title: 'Captions',
      description:
        "The words you see on the video. Pick a style here, or 'No caption'. You can fix the actual text later in the editor.",
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="transcription-engine"]',
    popover: {
      title: 'Transcription',
      description:
        "Before making clips, the app writes out everything said in the video — that's the transcript. Captions and the editor's text come from it. Built-in transcription is free; Soniox is better for Arabic and other languages.",
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="quick-tools"]',
    popover: {
      title: 'Shortcuts',
      description:
        "Two shortcuts that skip straight to one job. Let's look at each.",
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="shortcut-captions"]',
    popover: {
      title: 'AI Captions',
      description:
        'Add or fix captions on a video without making clips — choose a style and it burns them in.',
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="shortcut-editor"]',
    popover: {
      title: 'Video Editor',
      description:
        'Open a video in the editor to trim it, fix captions, add text, and change transitions.',
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="recent-projects"]',
    popover: {
      title: 'Recent projects',
      description:
        'Finished and in-progress jobs collect here, so you can come back to any clip later.',
      side: 'bottom',
    },
  },
  {
    element: 'button[aria-label="Calendar"]',
    popover: {
      title: 'Calendar',
      description:
        "Plan ahead: see and manage clips you've scheduled to post. Click the calendar icon and I'll show you what's inside.",
      side: 'right',
    },
  },
  {
    element: '[data-tour="feedback-button"]',
    popover: {
      title: 'Feedback',
      description:
        "Spot a bug or want a feature? This button in the corner lets you tell us — it's always on screen.",
      side: 'top',
    },
  },
  {
    element: 'button[aria-label="Settings"]',
    popover: {
      title: 'Your Gemini key',
      description:
        "Gemini is the AI brain behind OpenShorts. The key is a ticket that lets the app use it — it's what watches your video and picks the best moments. You need it to make clips. I'll take you to Settings now.",
      side: 'right',
    },
  },
];

const calendarSteps = [
  {
    element: '[data-tour="calendar-page"]',
    popover: {
      title: 'Calendar',
      description:
        "Everything you've scheduled to post, on one screen. If you haven't connected Zernio yet, this screen will point you to Settings to add it — the calendar fills in once you do.",
      side: 'bottom',
    },
  },
  {
    // Only exists once a Zernio key is connected — falls back to a centered
    // popover for new users who haven't set one up.
    element: () => document.querySelector('[data-tour="calendar-schedule"]'),
    popover: {
      title: 'Schedule vs Analytics',
      description:
        "Schedule is where you plan posts. Analytics switches to see how your published clips performed.",
      side: 'bottom',
    },
  },
  {
    popover: {
      title: "That's the calendar",
      description:
        "I'll take you back to Clip Generator now and finish the tour there.",
    },
  },
];

const settingsSteps = [
  {
    element: '[data-tour="settings-page"]',
    popover: {
      title: 'Settings',
      description:
        'This is where you connect the pieces: your Gemini key (required) and social keys (optional).',
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="gemini-key-input"]',
    popover: {
      title: 'Gemini API key',
      description:
        "Paste your Gemini key here and click Set Key. It's stored only in your browser — never on a server.",
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="gemini-key-link"]',
    popover: {
      title: 'Get a free key',
      description:
        "No key yet? This link opens Google AI Studio, where you can create a free Gemini key in about a minute.",
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="gemini-key-video"]',
    popover: {
      title: 'Video tutorial',
      description:
        'Prefer to watch? This link opens a short video that walks you through getting your free Gemini key, step by step.',
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="zernio-section"]',
    popover: {
      title: 'Zernio (optional)',
      description:
        "Zernio connects your social accounts — TikTok, Instagram, Reels, Shorts and more. With it you can publish or schedule clips straight from the app. Making clips works fine without it.",
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="soniox-section"]',
    popover: {
      title: 'Soniox (optional)',
      description:
        "Soniox makes transcription much better for Arabic and other languages, if you need it. It needs its own key.",
      side: 'bottom',
    },
  },
  {
    popover: {
      title: 'All set',
      description:
        "You're ready. I'll take you back to Clip Generator — paste a link, hit Generate, and the tour picks up again when your clips are ready.",
    },
  },
];

const resultsSteps = [
  {
    element: '[data-tour="results-header"]',
    popover: {
      title: 'Your clips are ready',
      description:
        'Each clip gets a virality score so you can see at a glance which moments are worth posting.',
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="clip-card"]',
    popover: {
      title: 'A clip card',
      description:
        'Click a card to preview the clip and see its details, score, and transcript.',
      side: 'top',
    },
  },
  {
    // Falls back to a centered popover until the card is expanded.
    element: () => document.querySelector('[data-tour="edit-clip"]'),
    popover: {
      title: 'Fine-tune it',
      description:
        "Click 'Edit clip' to open the editor — you can fix captions, swap backgrounds, add text, and trim. The tour continues there.",
      side: 'left',
    },
  },
];

const editorSteps = [
  {
    element: '[data-tour="editor-topbar"]',
    popover: {
      title: 'The editor toolbar',
      description:
        'From here you can undo or redo changes, save them, and export the final clip.',
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="editor-canvas"]',
    popover: {
      title: 'The preview',
      description:
        'Your clip plays here. The controls above it change the layout, and you can click a person on the video to track them.',
      side: 'bottom',
    },
  },
  {
    element: '[data-tour="editor-tools"]',
    popover: {
      title: 'The tools rail',
      description:
        'Click a tool to open its panel: captions, text, background media, and transitions.',
      side: 'left',
    },
  },
  {
    element: '[data-tour="editor-timeline"]',
    popover: {
      title: 'The timeline',
      description:
        'The whole clip laid out on one strip. Drag clips, trim their edges, and drop in extra text or b-roll.',
      side: 'top',
    },
  },
  {
    popover: {
      title: "That's the tour!",
      description:
        'You are all set. Make something great, and export when you are happy with it.',
    },
  },
];

const STEPS = {
  app: appSteps,
  settings: settingsSteps,
  calendar: calendarSteps,
  results: resultsSteps,
  editor: editorSteps,
};

// Index of the Feedback step in appSteps — the calendar leg resumes the app
// tour here after it finishes.
export const APP_FEEDBACK_INDEX = appSteps.findIndex((s) => s.popover?.title === 'Feedback');
