/**
 * The language the voice loop runs in.
 *
 * Recognition, the synthesised voice and the wake word all have to agree: ask
 * Chrome for Russian dictation and then read the answer back with an English
 * voice and you get a machine that hears you perfectly and replies in gibberish.
 * One constant, imported by both ends, keeps them from drifting apart.
 *
 * Override it in `.env.local` with `VITE_SPEECH_LANG=en-GB` to put the original
 * British loop back; nothing else needs touching.
 */
export const SPEECH_LANG = (import.meta.env.VITE_SPEECH_LANG as string | undefined) ?? 'ru-RU'

/** `ru` from `ru-RU` — what voice tags have to start with to be eligible. */
export const SPEECH_LANG_PREFIX = SPEECH_LANG.slice(0, 2).toLowerCase()

/**
 * Whether the character's own language is in play.
 *
 * The voice scoring below is built around one specific performance — a British
 * male butler — and every rule in it is a name or an accent from that world.
 * None of it transfers, so outside English the scoring has to fall back to
 * something plainer rather than silently rejecting every available voice.
 */
export const SPEECH_LANG_IS_ENGLISH = /^en/i.test(SPEECH_LANG)

/** Voice tags come as `ru-RU` on some platforms and `ru_RU` on others. */
export const SPEECH_LANG_RE = new RegExp(`^${SPEECH_LANG_PREFIX}`, 'i')
