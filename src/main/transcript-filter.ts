// Whisper-family models "hear" stock phrases in silence or noise, mostly subtitle credits
// from their training data. A transcript that is only one of these is treated as no speech.

const SUBSTRING_MARKERS = ['amara.org']

const WHOLE_TRANSCRIPT_PHRASES = [
  'napisy stworzone przez społeczność',
  'napisy wykonane przez społeczność',
  'dziękuję za obejrzenie',
  'dzięki za obejrzenie',
  'dziękuję',
  'thanks for watching',
  'thank you for watching',
  'thank you',
  'subtitles by the amara org community',
  'you'
]

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.\s]/gu, ' ')
    .replace(/\.(?!\w)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isLikelyHallucination(transcript: string): boolean {
  const lower = transcript.toLowerCase()
  if (SUBSTRING_MARKERS.some((marker) => lower.includes(marker))) return true
  const normalized = normalize(transcript)
  return normalized.length === 0 || WHOLE_TRANSCRIPT_PHRASES.includes(normalized)
}
