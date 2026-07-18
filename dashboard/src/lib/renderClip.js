import { getApiUrl } from '../config';

/**
 * Kick off a server-side Remotion render and poll until it finishes.
 * @param {object} opts
 * @param {string} opts.jobId
 * @param {number} opts.clipIndex
 * @param {object} opts.props - ShortVideo input props for the renderer
 * @param {(progress: number) => void} [opts.onProgress] - 0–1 (or whatever the service reports)
 * @param {number} [opts.pollMs=1500]
 * @returns {Promise<{ outputUrl: string, filename: string }>}
 */
export async function renderClipOnServer({ jobId, clipIndex, props, onProgress, pollMs = 1500 }) {
    const res = await fetch(getApiUrl('/api/render'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jobId,
            clipIndex,
            props,
        }),
    });
    if (!res.ok) throw new Error(`Render service error (${res.status}). Is the renderer running?`);
    const { renderId } = await res.json();

    let outputUrl = null;
    for (;;) {
        await new Promise((r) => setTimeout(r, pollMs));
        const statusRes = await fetch(getApiUrl(`/api/render/${renderId}`));
        if (!statusRes.ok) throw new Error('Lost contact with the render service.');
        const status = await statusRes.json();
        if (onProgress) onProgress(status.progress ?? 0);
        if (status.status === 'done') {
            outputUrl = status.outputUrl;
            break;
        }
        if (status.status === 'error') {
            throw new Error(status.error || 'Render failed.');
        }
    }

    const filename = outputUrl.split('/').pop();
    return { outputUrl, filename };
}

/**
 * Promote a rendered file to be the clip's video_url (metadata + job + result.json).
 * @returns {Promise<{ success: boolean, new_video_url: string }>}
 */
export async function applyRender({ jobId, clipIndex, filename }) {
    const applyRes = await fetch(getApiUrl('/api/clips/apply-render'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_id: jobId, clip_index: clipIndex, filename }),
    });
    if (!applyRes.ok) throw new Error('Render finished but could not be applied to the clip.');
    return applyRes.json();
}
