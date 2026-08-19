import { useSyncExternalStore } from 'react';
import { subscribeTour, isTourActive } from './platformTour.js';

// True while a tour step is on screen. Components that render tour-only UI
// (e.g. the MediaInput clip options) read this via this hook so they
// re-render when the tour starts/stops.
export const useTourActive = () =>
  useSyncExternalStore(subscribeTour, isTourActive);
