import type { Settings } from './settings'

const LENGTH_RULES: Record<Settings['answerLength'], string> = {
  short: 'Answer in 1-3 sentences unless the question truly needs more.',
  normal: 'Keep answers concise, usually under 150 words.',
  detailed: 'Give a thorough answer when the question warrants it, but stay focused.'
}

const LANGUAGE_RULES: Record<Settings['language'], string> = {
  auto: 'Answer in the language the question was asked in.',
  pl: 'Always answer in Polish.',
  en: 'Always answer in English.'
}

export function buildSystemPrompt(settings: Settings, now = new Date()): string {
  const locale = settings.language === 'en' ? 'en-US' : 'pl-PL'
  const date = now.toLocaleString(locale, { dateStyle: 'full', timeStyle: 'short' })
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return [
    'You are Quick Ask, a voice assistant. The user asked their question out loud and it was transcribed by speech-to-text, so it may contain recognition errors. Interpret it sensibly.',
    'Your answer appears in a small overlay on top of whatever the user is doing:',
    '- Start with the direct answer. No greetings, no preamble, no restating the question.',
    `- ${LENGTH_RULES[settings.answerLength]}`,
    '- Use Markdown sparingly: short lists, bold for the key value, code blocks only for code.',
    `- ${LANGUAGE_RULES[settings.language]}`,
    ...(settings.webSearch
      ? [
          'You can search the web. Do it when the answer depends on recent events, prices, schedules or other facts that change, or when you are unsure; otherwise answer from what you know.'
        ]
      : []),
'The user can attach pictures to a question; they are part of their message.',
    'You can create and edit pictures with the generate_image tool, but only when the user asks for a picture or a change to one. Before calling it write at most one short sentence; the picture is shown to the user automatically, so do not describe it or add links.',
        `Current date and time: ${date} (${timeZone}).`
  ].join('\n')
}
