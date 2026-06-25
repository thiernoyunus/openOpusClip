# DOAC Podcast Trailer Research

Research notes for a possible OpenShorts **Podcast Trailer** mode.

## Files

- `doac-trailer-editing-skill-research-map.md` — best starting point; summarizes the learning map and future skill modules.
- `visual-reference.md` — screenshots from the actual Diary of a CEO intro clips, showing the caption and trailer look.
- `doac-five-ps-teaser-report.md` — story framework: Prove, Propose, Provide, Promise, Pose.
- `doac-2026-editing-style-report.md` — deeper tutorial notes on DOAC-style story, audio, captions, and After Effects polish.
- `doac-teaser-trailer-tutorial-report.md` — tutorial notes on making podcast teaser trailers like Diary of a CEO.

## Product Idea

Add a separate OpenShorts page, likely called **Podcast Trailer**, that reuses the existing upload/link/transcription/render pipeline but changes the AI goal:

- regular clipping mode: find multiple separate viral clips
- podcast trailer mode: build one ordered trailer/intro from multiple moments

MVP scope:

- paste YouTube link or upload podcast
- choose aspect ratio
- choose a Diary of a CEO style caption template
- AI selects one trailer timeline using the 5 P's structure
- render one intro video, not 7-8 separate clips

Skip for MVP:

- automatic B-roll
- complex sound design
- advanced After Effects-style transitions

Add those only after the story selection and caption style work.

## AI Selection Shape

Expected AI output should be structured, not prose:

```json
{
  "trailerTitle": "Example trailer title",
  "segments": [
    {
      "role": "prove",
      "start": 12.4,
      "end": 20.1,
      "reason": "Validates the episode promise",
      "captionEmphasis": ["burnout", "too late"]
    }
  ]
}
```

Roles should map to:

- `prove` — prove title/thumbnail promise
- `propose` — explain why the topic matters
- `provide` — establish social proof or credibility
- `promise` — hint at deeper hidden value
- `pose` — end with a cliffhanger/open loop

## Future Reference Prompt

In a new Codex chat for OpenShorts, paste:

> Use `/Users/thiernodiallo/Coding/openshorts/docs/research/doac-podcast-trailers/README.md` as context. I want to explore adding a Podcast Trailer mode to OpenShorts that creates one Diary of a CEO style intro from a podcast upload or YouTube link.
