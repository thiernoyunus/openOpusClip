import React, { useState } from 'react';
import {
    X, Loader2, Calendar, Clock, CheckCircle, AlertCircle, Video, Instagram, Youtube,
    ChevronLeft, ChevronRight, Globe, ExternalLink, Pencil, RotateCcw, Check, Plus
} from 'lucide-react';
import { getApiUrl } from '../config';
import { track } from '../analytics';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const DEFAULT_TIMES = ['09:00', '13:00', '18:00'];

// The only three settings YouTube accepts for who can see an upload.
const YT_VISIBILITIES = [
    { value: 'public', label: 'Public' },
    { value: 'unlisted', label: 'Unlisted' },
    { value: 'private', label: 'Private' },
];

// Zernio stores uploaded media for 7 days, so the backend rejects anything
// scheduled further out than that (app.py -> _reject_if_beyond_media_window).
const MEDIA_WINDOW_DAYS = 7;

const TIMEZONES = [
    { value: 'Pacific/Midway', label: '(GMT-11:00) Midway' },
    { value: 'Pacific/Honolulu', label: '(GMT-10:00) Honolulu' },
    { value: 'America/Anchorage', label: '(GMT-09:00) Alaska' },
    { value: 'America/Los_Angeles', label: '(GMT-08:00) Los Angeles' },
    { value: 'America/Denver', label: '(GMT-07:00) Denver' },
    { value: 'America/Mexico_City', label: '(GMT-06:00) Mexico City' },
    { value: 'America/Chicago', label: '(GMT-06:00) Chicago' },
    { value: 'America/New_York', label: '(GMT-05:00) New York' },
    { value: 'America/Bogota', label: '(GMT-05:00) Bogota' },
    { value: 'America/Caracas', label: '(GMT-04:00) Caracas' },
    { value: 'America/Santiago', label: '(GMT-04:00) Santiago' },
    { value: 'America/Argentina/Buenos_Aires', label: '(GMT-03:00) Buenos Aires' },
    { value: 'America/Sao_Paulo', label: '(GMT-03:00) Sao Paulo' },
    { value: 'Atlantic/Azores', label: '(GMT-01:00) Azores' },
    { value: 'UTC', label: '(GMT+00:00) UTC' },
    { value: 'Europe/London', label: '(GMT+00:00) London' },
    { value: 'Europe/Madrid', label: '(GMT+01:00) Madrid' },
    { value: 'Europe/Paris', label: '(GMT+01:00) Paris' },
    { value: 'Europe/Berlin', label: '(GMT+01:00) Berlin' },
    { value: 'Europe/Rome', label: '(GMT+01:00) Rome' },
    { value: 'Africa/Lagos', label: '(GMT+01:00) Lagos' },
    { value: 'Europe/Istanbul', label: '(GMT+03:00) Istanbul' },
    { value: 'Asia/Dubai', label: '(GMT+04:00) Dubai' },
    { value: 'Asia/Kolkata', label: '(GMT+05:30) India' },
    { value: 'Asia/Bangkok', label: '(GMT+07:00) Bangkok' },
    { value: 'Asia/Shanghai', label: '(GMT+08:00) Shanghai' },
    { value: 'Asia/Tokyo', label: '(GMT+09:00) Tokyo' },
    { value: 'Australia/Sydney', label: '(GMT+10:00) Sydney' },
    { value: 'Pacific/Auckland', label: '(GMT+12:00) Auckland' },
];

/* ------------------------------------------------------------------ *
 * Date helpers. Dates move around as plain "YYYY-MM-DD" day keys so a
 * clip's day never shifts because of a timezone conversion.
 * ------------------------------------------------------------------ */

const pad = (n) => String(n).padStart(2, '0');

function toDayKey(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDayKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
}

function addDays(dayKey, n) {
    const d = parseDayKey(dayKey);
    d.setDate(d.getDate() + n);
    return toDayKey(d);
}

/* ------------------------------------------------------------------ *
 * Post times. The list of times IS the schedule: five times a day
 * means five clips a day. Times are plain "HH:MM" strings, so they
 * sort and compare as text.
 * ------------------------------------------------------------------ */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const isValidTime = (t) => TIME_RE.test(t || '');

const timeToMinutes = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
};

const minutesToTime = (m) => {
    const x = ((m % 1440) + 1440) % 1440;
    return `${pad(Math.floor(x / 60))}:${pad(x % 60)}`;
};

/**
 * The times actually used for scheduling: junk dropped, exact duplicates
 * collapsed, sorted earliest-first. Sorting happens here rather than as the
 * user types, so rows never jump around under the cursor mid-edit.
 * Never returns an empty list — zero post times has no meaning.
 */
function normalizeTimes(times) {
    const clean = [...new Set((times || []).filter(isValidTime))].sort();
    return clean.length > 0 ? clean : ['12:00'];
}

/** A fresh time for the "Add time" button: an unused default, else an hour past the latest. */
function nextTimeSlot(existing) {
    const taken = new Set(existing.filter(isValidTime));
    const unusedDefault = DEFAULT_TIMES.find((t) => !taken.has(t));
    if (unusedDefault) return unusedDefault;

    const latest = [...taken].sort().pop();
    const base = latest ? timeToMinutes(latest) : 9 * 60;
    for (let step = 60; step <= 1440; step += 15) {
        const candidate = minutesToTime(base + step);
        if (!taken.has(candidate)) return candidate;
    }
    for (let step = 1; step <= 1440; step += 1) {
        const candidate = minutesToTime(base + step);
        if (!taken.has(candidate)) return candidate;
    }
    return '12:00';
}

// `today` is the current day in the timezone being scheduled for — not the
// browser's — so "Today"/"Tomorrow" mean what the user is actually picking.
function formatDayKey(dayKey, today) {
    const d = parseDayKey(dayKey);
    if (dayKey === today) return 'Today';
    if (dayKey === addDays(today, 1)) return 'Tomorrow';
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/**
 * The current wall-clock time in an IANA timezone, as "YYYY-MM-DDTHH:mm".
 * Same shape as a slot's own date+time, so the two can be compared as strings.
 */
function nowInTimezone(timezone) {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(new Date()).reduce((acc, p) => {
            acc[p.type] = p.value;
            return acc;
        }, {});
        const hour = parts.hour === '24' ? '00' : parts.hour;
        return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
    } catch {
        const d = new Date();
        return `${toDayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
}

/** Today's calendar day in an IANA timezone, as "YYYY-MM-DD". */
function todayInTimezone(timezone) {
    return nowInTimezone(timezone).split('T')[0];
}

/**
 * Turns the scheduling settings into one dated slot per clip.
 *
 * The post times are the schedule: one clip goes out at each time, then the
 * next day starts. Three times (09:00 / 13:00 / 18:00) means clips 1-3 land
 * on day one and clip 4 opens day two. A per-clip override replaces that
 * clip's slot without disturbing anyone else's.
 *
 * Pure — no React, no clock reads except the "is this in the past" flag,
 * which takes the current time as an argument.
 *
 * @returns {Array<{index, date, time, autoDate, autoTime, edited, isPast}>}
 */
function computeScheduleSlots({ clipCount, startDate, times, overrides = {}, now = null }) {
    const slotTimes = normalizeTimes(times);
    const perDay = slotTimes.length;
    const slots = [];

    for (let i = 0; i < clipCount; i++) {
        const autoDate = addDays(startDate, Math.floor(i / perDay));
        const autoTime = slotTimes[i % perDay];
        const override = overrides[i];
        const date = override?.date || autoDate;
        const time = override?.time || autoTime;
        slots.push({
            index: i,
            date,
            time,
            autoDate,
            autoTime,
            edited: Boolean(override) && (date !== autoDate || time !== autoTime),
            isPast: now ? `${date}T${time}` <= now : false,
        });
    }
    return slots;
}

/**
 * The smallest number of daily post times that fits every clip inside the
 * 7-day window, assuming the day's latest post stays where it is.
 * Returns null when even posting everything on the start day is too late.
 */
function suggestPerDay({ clipCount, startDate, latestTime, windowEnd }) {
    for (let n = 1; n <= Math.max(1, clipCount); n++) {
        const lastDay = addDays(startDate, Math.floor((clipCount - 1) / n));
        if (`${lastDay}T${latestTime}` <= windowEnd) return n;
    }
    return null;
}

function detectTimezone() {
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (TIMEZONES.find((t) => t.value === tz)) return tz;
        return 'UTC';
    } catch {
        return 'UTC';
    }
}

function PlatformIcon({ platform }) {
    if (platform === 'tiktok') return <Video size={14} className="text-cyan-400" />;
    if (platform === 'instagram') return <Instagram size={14} className="text-pink-400" />;
    if (platform === 'youtube') return <Youtube size={14} className="text-red-400" />;
    return <Globe size={14} className="text-muted" />;
}

export default function ScheduleWeekModal({ isOpen, onClose, clips, jobId, zernioKey, socialAccounts = [], onViewCalendar }) {
    const [timezone, setTimezone] = useState(detectTimezone);
    const [times, setTimes] = useState(DEFAULT_TIMES); // one clip goes out at each time, every day
    const [startOffset, setStartOffset] = useState(1); // days from today
    const [overrides, setOverrides] = useState({});    // clipIndex -> { date, time }
    const [openRow, setOpenRow] = useState(null);      // clipIndex whose editor is expanded

    // Account selection: every connected account defaults to ON until unticked
    const [accountToggles, setAccountToggles] = useState({});
    const [ytVisibility, setYtVisibility] = useState({}); // { [accountId]: 'public' | 'unlisted' | 'private' }

    const [scheduling, setScheduling] = useState(false);
    const [progress, setProgress] = useState({ current: 0, total: 0, results: [] });
    const [done, setDone] = useState(false);
    const [warning, setWarning] = useState(null);

    // Everything below is derived fresh each render, on purpose. It is a couple
    // of loops over a handful of clips and post times — cheaper than the memo
    // bookkeeping around it, and it keeps every value on one consistent clock
    // reading instead of a mix of cached and live ones.
    const clipCount = clips?.length || 0;

    // Dates hang off the SELECTED timezone's calendar day, not the browser's.
    // Schedule for Los Angeles from a laptop in Tokyo near midnight and the two
    // are different dates — mixing them shifts the whole run by a day and can
    // block a date that is still valid where you're posting.
    const todayInTz = todayInTimezone(timezone);
    const startDate = addDays(todayInTz, startOffset);
    const now = nowInTimezone(timezone);

    const slots = computeScheduleSlots({ clipCount, startDate, times, overrides, now });

    const pastSlots = slots.filter((s) => s.isPast);

    // Rows the user still has to fix before anything can be scheduled.
    const badTimes = (() => {
        const seen = new Set();
        const duplicate = new Set();
        const empty = new Set();
        times.forEach((t, i) => {
            if (!isValidTime(t)) {
                empty.add(i);
                return;
            }
            if (seen.has(t)) duplicate.add(i);
            else seen.add(t);
        });
        return { duplicate, empty };
    })();

    const hasBadTimes = badTimes.duplicate.size > 0 || badTimes.empty.size > 0;

    // The last moment Zernio will still accept, in the same "YYYY-MM-DDTHH:mm"
    // shape as a slot, so the two compare as plain text.
    const windowEnd = (() => {
        const [day, time] = now.split('T');
        return `${addDays(day, MEDIA_WINDOW_DAYS)}T${time}`;
    })();

    const lateSlots = slots.filter((s) => `${s.date}T${s.time}` > windowEnd);

    // Two clips must not share a minute — the post service rejects a duplicate
    // (account, minute) pair. Deduping the post-times list isn't enough: a
    // per-clip override can land on top of another clip's slot, and that only
    // shows up here, on the final dates.
    const clashingSlots = (() => {
        const byMoment = new Map();
        slots.forEach((s) => {
            const moment = `${s.date}T${s.time}`;
            byMoment.set(moment, (byMoment.get(moment) || 0) + 1);
        });
        return new Set(
            slots.filter((s) => byMoment.get(`${s.date}T${s.time}`) > 1).map((s) => s.index)
        );
    })();

    // Reset state when modal reopens
    const prevOpen = React.useRef(false);
    React.useEffect(() => {
        if (isOpen && !prevOpen.current) {
            setScheduling(false);
            setDone(false);
            setProgress({ current: 0, total: 0, results: [] });
            setOverrides({});
            setOpenRow(null);
            setWarning(null);
        }
        prevOpen.current = isOpen;
    }, [isOpen]);

    if (!isOpen) return null;

    const selectedAccounts = socialAccounts.filter((a) => accountToggles[a.id] ?? true);
    const perDay = normalizeTimes(times).length;
    const dayCount = Math.ceil(clipCount / perDay) || 0;

    // Plain-English fix for the 7-day ceiling, phrased in terms of the post-times list.
    const lateAdvice = (() => {
        if (lateSlots.length === 0) return null;
        const latestTime = normalizeTimes(times)[perDay - 1];
        const needed = suggestPerDay({ clipCount, startDate, latestTime, windowEnd });
        if (needed === null) {
            return 'Even posting all of them on one day is too late — start on an earlier date.';
        }
        if (needed > perDay) {
            return `Add more posting times so they all fit: ${needed} a day covers ${clipCount} clip${clipCount === 1 ? '' : 's'}.`;
        }
        return 'Move the late ones to an earlier date.';
    })();

    const setTimeAt = (i, value) => setTimes((t) => t.map((v, idx) => (idx === i ? value : v)));

    const addTime = () => setTimes((t) => [...t, nextTimeSlot(t)]);

    // A schedule with no post times has no meaning, so the last row can't go.
    const removeTime = (i) => setTimes((t) => (t.length <= 1 ? t : t.filter((_, idx) => idx !== i)));

    const setOverride = (index, patch) => {
        setOverrides((prev) => {
            const slot = slots.find((s) => s.index === index);
            const base = prev[index] || { date: slot?.date, time: slot?.time };
            return { ...prev, [index]: { ...base, ...patch } };
        });
    };

    const clearOverride = (index) => {
        setOverrides((prev) => {
            const next = { ...prev };
            delete next[index];
            return next;
        });
    };

    // Nudge everything that already passed one day forward, so nothing is
    // silently posted into the past.
    const pushPastForward = () => {
        setStartOffset((o) => o + 1);
        setOverrides((prev) => {
            const next = { ...prev };
            slots.forEach((s) => {
                if (s.isPast && next[s.index]) {
                    next[s.index] = { ...next[s.index], date: addDays(next[s.index].date, 1) };
                }
            });
            return next;
        });
        setWarning(null);
    };

    const handleScheduleAll = async () => {
        if (!zernioKey) return;
        if (selectedAccounts.length === 0) return;

        if (hasBadTimes) {
            setWarning('Fix the post times first — every time must be filled in and different from the others.');
            return;
        }

        if (clashingSlots.size > 0) {
            setWarning(`${clashingSlots.size} clips are set for the same moment as another clip. Give each one its own time before scheduling.`);
            return;
        }

        // Re-check against the clock at submit time — the modal may have been
        // sitting open long enough for a slot to slip into the past.
        const freshNow = nowInTimezone(timezone);
        const fresh = computeScheduleSlots({ clipCount, startDate, times, overrides, now: freshNow });
        const stale = fresh.filter((s) => s.isPast);
        if (stale.length > 0) {
            setWarning(`${stale.length} clip${stale.length === 1 ? ' is' : 's are'} scheduled in the past. Move them forward before scheduling.`);
            return;
        }

        // Zernio rejects anything past the 7-day media window, so never start
        // uploading a batch that is guaranteed to fail partway through.
        const [freshDay, freshTime] = freshNow.split('T');
        const freshWindowEnd = `${addDays(freshDay, MEDIA_WINDOW_DAYS)}T${freshTime}`;
        const tooLate = fresh.filter((s) => `${s.date}T${s.time}` > freshWindowEnd);
        if (tooLate.length > 0) {
            setWarning(`${tooLate.length} clip${tooLate.length === 1 ? ' is' : 's are'} set for more than ${MEDIA_WINDOW_DAYS} days from now, which is further ahead than we can book. Add more posting times, or start on an earlier date.`);
            return;
        }

        setWarning(null);
        setScheduling(true);
        setDone(false);
        const _platforms = [...new Set(selectedAccounts.map((a) => a.platform))].sort().join('-');
        const platformCount = _platforms ? _platforms.split('-').length : 0;
        const total = fresh.length;
        setProgress({ current: 0, total, results: [] });

        const results = [];
        for (let i = 0; i < fresh.length; i++) {
            const { index, date, time } = fresh[i];
            const clip = clips[index];

            // Local datetime string: "2026-04-06T12:00:00"
            // Zernio interprets it in the IANA timezone sent alongside
            const scheduledDate = `${date}T${time}:00`;

            const payload = {
                job_id: jobId,
                clip_index: index,
                api_key: zernioKey,
                accounts: selectedAccounts.map((a) => {
                    const target = { accountId: a.id, platform: a.platform };
                    if (a.platform === 'youtube') target.visibility = ytVisibility[a.id] || 'public';
                    return target;
                }),
                title: clip.video_title_for_youtube_short || 'Viral Short',
                description: clip.video_description_for_instagram || clip.video_description_for_tiktok || '',
                scheduled_date: scheduledDate,
                timezone
            };

            try {
                track('social_post_started', { mode: 'schedule', source: 'week_scheduler', platform_count: platformCount, platforms: _platforms });
                const res = await fetch(getApiUrl('/api/social/post'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!res.ok) {
                    const errText = await res.text();
                    throw new Error(errText);
                }

                results.push({ index: i, success: true });
                track('social_post_completed', { mode: 'schedule', source: 'week_scheduler', platform_count: platformCount, platforms: _platforms });
            } catch (e) {
                results.push({ index: i, success: false, error: e.message });
                track('social_post_failed', { mode: 'schedule', source: 'week_scheduler', platform_count: platformCount, platforms: _platforms, error_category: 'client' });
            }

            setProgress({ current: i + 1, total, results: [...results] });
        }

        setDone(true);
        setScheduling(false);
    };

    const successCount = progress.results.filter((r) => r.success).length;
    const failCount = progress.results.filter((r) => !r.success).length;
    const inputClass = 'bg-surface2 border border-edge rounded-lg px-3 py-2 text-sm text-fg focus:outline-none focus:border-viral/40 disabled:opacity-50 [color-scheme:dark]';
    const labelClass = 'block text-[11px] font-medium text-muted uppercase tracking-wider mb-2';

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-[fadeIn_0.2s_ease-out]">
            <div className="w-full max-w-2xl max-h-[calc(100vh-32px)] rounded-xl border border-edge bg-surface shadow-2xl flex flex-col overflow-hidden">
                {/* Header */}
                <div className="flex items-center justify-between gap-3 px-5 h-14 border-b border-edge shrink-0">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="size-9 rounded-lg border border-edge bg-surface2 flex items-center justify-center shrink-0">
                            <Calendar size={16} className="text-viral" />
                        </div>
                        <div className="min-w-0">
                            <h2 className="text-sm font-medium text-fg">Schedule clips</h2>
                            <p className="text-[11px] text-muted truncate">
                                {clipCount} clip{clipCount === 1 ? '' : 's'} &middot; {perDay} per day &middot; {dayCount} day{dayCount === 1 ? '' : 's'}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        disabled={scheduling}
                        className="size-8 rounded-md text-muted hover:text-fg hover:bg-white/5 flex items-center justify-center disabled:opacity-40 shrink-0"
                        aria-label="Close"
                    >
                        <X size={16} />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-5 space-y-5">
                    {!zernioKey && (
                        <div className="p-3 bg-amber-500/10 border border-amber-500/20 text-amber-200 text-xs rounded-lg flex items-start gap-2">
                            <AlertCircle size={14} className="mt-0.5 shrink-0" />
                            <div>Add your Zernio API key in Settings first.</div>
                        </div>
                    )}

                    {/* Post times + timezone. The list of times is the schedule:
                        one clip goes out at each time, so 5 times = 5 clips a day. */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                            <label className={labelClass}>
                                <span className="inline-flex items-center gap-1.5">
                                    <Clock size={12} /> Post times
                                </span>
                            </label>
                            <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar pr-1">
                                {times.map((t, i) => {
                                    const isDuplicate = badTimes.duplicate.has(i);
                                    const isEmpty = badTimes.empty.has(i);
                                    return (
                                        <div key={i}>
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="time"
                                                    value={t}
                                                    onChange={(e) => setTimeAt(i, e.target.value)}
                                                    disabled={scheduling}
                                                    className={`${inputClass} flex-1 min-w-0 ${isDuplicate || isEmpty ? '!border-red-500/40' : ''}`}
                                                    aria-label={`Post time ${i + 1}`}
                                                    aria-invalid={isDuplicate || isEmpty}
                                                />
                                                <button
                                                    type="button"
                                                    onClick={() => removeTime(i)}
                                                    disabled={scheduling || times.length <= 1}
                                                    title={times.length <= 1 ? 'Keep at least one post time' : 'Remove this time'}
                                                    className="size-8 shrink-0 rounded-md border border-edge bg-surface2 text-muted hover:text-fg hover:bg-white/5 disabled:opacity-30 disabled:hover:text-muted flex items-center justify-center"
                                                    aria-label={`Remove post time ${i + 1}`}
                                                >
                                                    <X size={13} />
                                                </button>
                                            </div>
                                            {(isDuplicate || isEmpty) && (
                                                <p className="text-[10px] text-red-300 mt-1">
                                                    {isEmpty ? 'Pick a time.' : 'Already in the list — two clips cannot share a time.'}
                                                </p>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                            <button
                                type="button"
                                onClick={addTime}
                                disabled={scheduling}
                                className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-fg border border-edge bg-surface2 hover:bg-white/5 rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-50"
                            >
                                <Plus size={12} /> Add time
                            </button>
                            <p className="text-[11px] text-muted mt-2">
                                {perDay} clip{perDay === 1 ? '' : 's'} a day &middot; {dayCount} day{dayCount === 1 ? '' : 's'} to post {clipCount} clip{clipCount === 1 ? '' : 's'}
                            </p>
                        </div>

                        <div>
                            <label className={labelClass}>
                                <span className="inline-flex items-center gap-1.5">
                                    <Globe size={12} /> Timezone
                                </span>
                            </label>
                            <select
                                value={timezone}
                                onChange={(e) => setTimezone(e.target.value)}
                                disabled={scheduling}
                                className={`${inputClass} w-full cursor-pointer`}
                            >
                                {TIMEZONES.map((tz) => (
                                    <option key={tz.value} value={tz.value}>{tz.label}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Start date stepper */}
                    <div className="flex items-center justify-between gap-3">
                        <span className={`${labelClass} mb-0`}>Start on</span>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setStartOffset(Math.max(0, startOffset - 1))}
                                disabled={startOffset <= 0 || scheduling}
                                className="size-7 rounded-md border border-edge bg-surface2 text-muted hover:text-fg hover:bg-white/5 disabled:opacity-30 flex items-center justify-center"
                                aria-label="Previous day"
                            >
                                <ChevronLeft size={14} />
                            </button>
                            <span className="text-sm text-fg min-w-[130px] text-center tabular-nums">
                                {formatDayKey(startDate, todayInTz)}
                            </span>
                            <button
                                type="button"
                                onClick={() => setStartOffset(startOffset + 1)}
                                disabled={scheduling}
                                className="size-7 rounded-md border border-edge bg-surface2 text-muted hover:text-fg hover:bg-white/5 disabled:opacity-30 flex items-center justify-center"
                                aria-label="Next day"
                            >
                                <ChevronRight size={14} />
                            </button>
                        </div>
                    </div>

                    {/* Past-time guard */}
                    {(pastSlots.length > 0 || warning) && (
                        <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2">
                            <AlertCircle size={14} className="mt-0.5 shrink-0 text-red-400" />
                            <div className="flex-1 min-w-0">
                                <p className="text-xs text-red-200">
                                    {warning || `${pastSlots.length} clip${pastSlots.length === 1 ? ' is' : 's are'} set for a time that has already gone by. Nothing will be scheduled until you move ${pastSlots.length === 1 ? 'it' : 'them'}.`}
                                </p>
                                <button
                                    type="button"
                                    onClick={pushPastForward}
                                    disabled={scheduling}
                                    className="mt-2 text-[11px] text-red-200 hover:text-fg border border-red-500/30 hover:bg-white/5 rounded-md px-2.5 py-1 transition-colors disabled:opacity-50"
                                >
                                    Move everything a day forward
                                </button>
                            </div>
                        </div>
                    )}

                    {/* 7-day ceiling: Zernio deletes uploaded video after a week, so
                        anything further out is rejected. Say so before we upload. */}
                    {lateSlots.length > 0 && (
                        <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg flex items-start gap-2">
                            <AlertCircle size={14} className="mt-0.5 shrink-0 text-amber-400" />
                            <p className="text-xs text-amber-200">
                                {lateSlots.length} clip{lateSlots.length === 1 ? ' is' : 's are'} set for more than {MEDIA_WINDOW_DAYS} days
                                from now &mdash; further ahead than we can book. Your videos are sent to the scheduling
                                service today, and it only keeps them for {MEDIA_WINDOW_DAYS} days, so there would be
                                nothing left to post. {lateAdvice}
                            </p>
                        </div>
                    )}

                    {/* Schedule list — every row opens its own date + time */}
                    <div>
                        <label className={labelClass}>Schedule &middot; tap a clip to change its date or time</label>
                        <div className="space-y-1.5">
                            {slots.map((slot) => {
                                const clip = clips[slot.index];
                                const result = progress.results[slot.index];
                                const isOpen_ = openRow === slot.index;
                                const isLate = `${slot.date}T${slot.time}` > windowEnd;
                                return (
                                    <div
                                        key={slot.index}
                                        className={`rounded-lg border transition-colors ${slot.isPast ? 'border-red-500/30 bg-red-500/5' : isLate ? 'border-amber-500/30 bg-amber-500/5' : isOpen_ ? 'border-viral/40 bg-surface2' : 'border-edge bg-surface2 hover:border-white/20'}`}
                                    >
                                        <button
                                            type="button"
                                            onClick={() => setOpenRow(isOpen_ ? null : slot.index)}
                                            disabled={scheduling}
                                            className="w-full flex items-center gap-3 p-3 text-left disabled:cursor-not-allowed"
                                        >
                                            <div className="w-14 shrink-0 text-center">
                                                <div className="text-[10px] font-medium text-muted uppercase">{DAYS[parseDayKey(slot.date).getDay()]}</div>
                                                <div className="text-lg font-semibold text-fg leading-tight tabular-nums">{parseDayKey(slot.date).getDate()}</div>
                                                <div className="text-[10px] text-muted">{MONTHS[parseDayKey(slot.date).getMonth()]}</div>
                                            </div>

                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2">
                                                    <span className="text-xs font-medium text-fg">Clip {slot.index + 1}</span>
                                                    {slot.edited && (
                                                        <span className="inline-flex items-center gap-1 text-[10px] text-viral border border-viral/30 bg-viral/10 rounded px-1.5 py-0.5">
                                                            <Pencil size={9} /> Edited
                                                        </span>
                                                    )}
                                                    {slot.isPast && (
                                                        <span className="text-[10px] text-red-300 border border-red-500/30 rounded px-1.5 py-0.5">In the past</span>
                                                    )}
                                                    {!slot.isPast && isLate && (
                                                        <span className="text-[10px] text-amber-300 border border-amber-500/30 rounded px-1.5 py-0.5">Too far out</span>
                                                    )}
                                                    {clashingSlots.has(slot.index) && (
                                                        <span className="text-[10px] text-red-300 border border-red-500/30 rounded px-1.5 py-0.5">Same time as another clip</span>
                                                    )}
                                                </div>
                                                <div className="text-[11px] text-muted truncate">
                                                    {clip?.video_title_for_youtube_short || 'Viral Short'}
                                                </div>
                                                <div className="text-[11px] text-muted mt-0.5 tabular-nums">
                                                    {formatDayKey(slot.date, todayInTz)} &middot; {slot.time}
                                                </div>
                                            </div>

                                            <div className="shrink-0">
                                                {result?.success === true && <CheckCircle size={16} className="text-viral" />}
                                                {result?.success === false && <AlertCircle size={16} className="text-red-400" />}
                                                {scheduling && progress.current === slot.index && (
                                                    <Loader2 size={16} className="text-viral animate-spin" />
                                                )}
                                                {!scheduling && result === undefined && (
                                                    <Pencil size={14} className={isOpen_ ? 'text-viral' : 'text-zinc-600'} />
                                                )}
                                            </div>
                                        </button>

                                        {isOpen_ && !scheduling && (
                                            <div className="px-3 pb-3 pt-1 border-t border-edge flex flex-wrap items-end gap-3 animate-[fadeIn_0.15s_ease-out]">
                                                <div>
                                                    <span className="block text-[10px] text-muted mb-1">Date</span>
                                                    <input
                                                        type="date"
                                                        value={slot.date}
                                                        min={todayInTz}
                                                        onChange={(e) => e.target.value && setOverride(slot.index, { date: e.target.value })}
                                                        className={inputClass}
                                                        aria-label={`Date for clip ${slot.index + 1}`}
                                                    />
                                                </div>
                                                <div>
                                                    <span className="block text-[10px] text-muted mb-1">Time</span>
                                                    <input
                                                        type="time"
                                                        value={slot.time}
                                                        onChange={(e) => e.target.value && setOverride(slot.index, { time: e.target.value })}
                                                        className={inputClass}
                                                        aria-label={`Time for clip ${slot.index + 1}`}
                                                    />
                                                </div>
                                                <div className="flex items-center gap-2 ml-auto">
                                                    {slot.edited && (
                                                        <button
                                                            type="button"
                                                            onClick={() => clearOverride(slot.index)}
                                                            className="inline-flex items-center gap-1.5 text-[11px] text-muted hover:text-fg border border-edge hover:bg-white/5 rounded-md px-2.5 py-1.5 transition-colors"
                                                        >
                                                            <RotateCcw size={11} /> Reset
                                                        </button>
                                                    )}
                                                    <button
                                                        type="button"
                                                        onClick={() => setOpenRow(null)}
                                                        className="inline-flex items-center gap-1.5 text-[11px] text-fg border border-edge bg-surface hover:bg-white/5 rounded-md px-2.5 py-1.5 transition-colors"
                                                    >
                                                        <Check size={11} /> Done
                                                    </button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                            {clipCount === 0 && (
                                <p className="text-xs text-muted p-3 bg-surface2 rounded-lg border border-edge">No clips to schedule yet.</p>
                            )}
                        </div>
                    </div>

                    {/* Accounts */}
                    <div>
                        <label className={labelClass}>Post to</label>
                        {socialAccounts.length === 0 ? (
                            <p className="text-xs text-muted p-3 bg-surface2 rounded-lg border border-edge">
                                No accounts connected. Connect them in Settings &rarr; Social Integration.
                            </p>
                        ) : (
                            <>
                                <div className="flex flex-wrap gap-2">
                                    {socialAccounts.map((acc) => {
                                        const on = accountToggles[acc.id] ?? true;
                                        return (
                                            <button
                                                key={acc.id}
                                                type="button"
                                                onClick={() => setAccountToggles((t) => ({ ...t, [acc.id]: !on }))}
                                                disabled={scheduling}
                                                aria-pressed={on}
                                                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs border transition-colors disabled:opacity-50 ${on ? 'bg-viral/10 border-viral/40 text-fg' : 'bg-surface2 border-edge text-muted hover:text-fg'}`}
                                            >
                                                <span className={`size-4 rounded border flex items-center justify-center shrink-0 ${on ? 'bg-viral/20 border-viral/50 text-viral' : 'border-edge text-transparent'}`}>
                                                    <Check size={10} />
                                                </span>
                                                <PlatformIcon platform={acc.platform} />
                                                {acc.displayName || acc.username}
                                            </button>
                                        );
                                    })}
                                </div>
                                <p className="text-[11px] text-muted mt-2">
                                    {selectedAccounts.length === 0
                                        ? 'Pick at least one account.'
                                        : `Every clip goes out to all ${selectedAccounts.length} ticked account${selectedAccounts.length === 1 ? '' : 's'}.`}
                                </p>

                                {/* YouTube: who can see the uploads. Same three values the
                                    single-clip publisher offers, so the two agree. */}
                                {selectedAccounts.filter((a) => a.platform === 'youtube').map((acc) => (
                                    <div key={acc.id} className="mt-3 p-3 bg-surface2 border border-edge rounded-lg">
                                        <div className={labelClass}>
                                            <span className="inline-flex items-center gap-1.5">
                                                <Youtube size={12} /> Who can see it on {acc.displayName || acc.username}
                                            </span>
                                        </div>
                                        <div className="flex gap-1 p-0.5 bg-black/40 border border-edge rounded-lg">
                                            {YT_VISIBILITIES.map((v) => {
                                                const active = (ytVisibility[acc.id] || 'public') === v.value;
                                                return (
                                                    <button
                                                        key={v.value}
                                                        type="button"
                                                        onClick={() => setYtVisibility((s) => ({ ...s, [acc.id]: v.value }))}
                                                        disabled={scheduling}
                                                        className={`flex-1 py-1.5 rounded-md text-xs transition-colors disabled:opacity-50 ${active ? 'bg-surface2 text-fg' : 'text-muted hover:text-fg'}`}
                                                    >
                                                        {v.label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                        <p className="mt-2 text-[11px] text-muted leading-snug">
                                            Scheduled uploads go up right away as private, then switch to your choice at the scheduled time.
                                        </p>
                                    </div>
                                ))}
                            </>
                        )}
                    </div>

                    {/* Progress */}
                    {(scheduling || done) && (
                        <div>
                            <div className="flex items-center justify-between text-[11px] text-muted mb-2">
                                <span>{scheduling ? 'Scheduling...' : 'Finished'}</span>
                                <span className="tabular-nums">{progress.current}/{progress.total}</span>
                            </div>
                            <div className="w-full h-1.5 bg-surface2 border border-edge rounded-full overflow-hidden">
                                <div
                                    className={`h-full rounded-full transition-all duration-500 ${done && failCount === 0 ? 'bg-viral' : done && failCount > 0 ? 'bg-amber-500' : 'bg-viral/70'}`}
                                    style={{ width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }}
                                />
                            </div>
                            {done && (
                                <div className="mt-3 text-xs text-center">
                                    {failCount === 0 ? (
                                        <span className="text-viral">All clips scheduled</span>
                                    ) : (
                                        <span className="text-amber-400">{successCount} scheduled, {failCount} failed</span>
                                    )}
                                </div>
                            )}
                        </div>
                    )}
                </div>

                {/* Footer */}
                <div className="shrink-0 border-t border-edge p-4 flex items-center gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={scheduling}
                        className="text-xs text-muted hover:text-fg border border-edge hover:bg-white/5 rounded-lg px-4 py-2.5 transition-colors disabled:opacity-50"
                    >
                        {done ? 'Close' : 'Cancel'}
                    </button>
                    <div className="flex-1" />
                    {!done ? (
                        <button
                            type="button"
                            onClick={handleScheduleAll}
                            disabled={scheduling || !zernioKey || clipCount === 0 || selectedAccounts.length === 0 || pastSlots.length > 0 || lateSlots.length > 0 || hasBadTimes || clashingSlots.size > 0}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-viral/15 border border-viral/40 text-sm text-viral hover:bg-viral/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                            {scheduling ? (
                                <>
                                    <Loader2 size={14} className="animate-spin" /> Scheduling...
                                </>
                            ) : (
                                <>
                                    <Calendar size={14} /> Schedule {clipCount} clip{clipCount === 1 ? '' : 's'}
                                </>
                            )}
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={() => { onClose(); if (onViewCalendar) onViewCalendar(); }}
                            className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-viral/15 border border-viral/40 text-sm text-viral hover:bg-viral/25 transition-colors"
                        >
                            <ExternalLink size={14} /> View calendar
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
