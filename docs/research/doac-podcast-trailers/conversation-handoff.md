# Conversation Handoff

This captures the useful context from the Codex conversation that produced these DOAC podcast trailer notes.

## What We Were Doing

We watched several Diary of a CEO reference clips and editing tutorials to understand how their podcast intros/trailers work.

The goal was not just to summarize videos. The bigger goal is to learn the pattern well enough to build a future skill or OpenShorts feature that can help create this kind of trailer.

## User's Product Idea

Add a separate OpenShorts page, probably called **Podcast Trailer**.

It would reuse the existing upload/link/transcription/render flow, but the AI task would be different:

- normal OpenShorts clipping finds several separate viral clips
- Podcast Trailer mode creates one ordered intro/trailer from multiple moments

The user specifically clarified that the caption style should match **Diary of a CEO**.

Visual examples from the real DOAC intros are saved in:

- `/Users/thiernodiallo/Coding/openshorts/docs/research/doac-podcast-trailers/visual-reference.md`

## Current MVP Thinking

Start simple:

- upload a podcast or paste a YouTube link
- choose aspect ratio
- choose a Diary of a CEO style caption template
- transcribe the full video
- AI selects moments using a trailer structure
- output one intro/trailer video

Skip for MVP:

- automatic B-roll
- advanced sound design
- heavy transition generation

Those can come later. First prove that the AI can pick the right moments and order them well.

## Core Trailer Structure

The clearest structure from the research is the 5 P's:

1. **Prove** the title/thumbnail promise.
2. **Propose** why the topic matters.
3. **Provide** social proof or credibility.
4. **Promise** hidden value.
5. **Pose** a cliffhanger/open loop.

Beginner version: every selected clip needs a job. If it does not prove, raise stakes, build trust, hint at deeper value, or create a cliffhanger, it probably does not belong in the intro.

## Caption Direction

Diary of a CEO style captions should feel like trailer typography, not normal subtitles:

- big bold text
- phrase-by-phrase or word-by-word timing
- full-screen caption moments for important lines
- darkened or blurred background when text is the main focus
- selected emphasis words in a strong accent color
- subtle fade/scale motion
- dramatic pauses where captions disappear

## OpenShorts Context Mentioned

Known from prior OpenShorts work:

- canonical repo: `/Users/thiernodiallo/Coding/openshorts`
- Remotion is used for rendering
- caption templates and motion already exist in the project
- before adding new caption motion, check existing template motion so effects do not double-stack

## Suggested Future Codex Prompt

Use this in a new OpenShorts-focused chat:

> Use `/Users/thiernodiallo/Coding/openshorts/docs/research/doac-podcast-trailers/README.md`, `/Users/thiernodiallo/Coding/openshorts/docs/research/doac-podcast-trailers/conversation-handoff.md`, and `/Users/thiernodiallo/Coding/openshorts/docs/research/doac-podcast-trailers/visual-reference.md` as context. I want to explore adding a Podcast Trailer mode to OpenShorts that creates one Diary of a CEO style intro from a podcast upload or YouTube link.
