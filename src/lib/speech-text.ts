/**
 * The text side of the voice loop, with nothing of the browser in it.
 *
 * Everything here is a pure function of strings: what counts as his name, when
 * a sentence looks finished, how two transcripts of one thought are joined, and
 * whether a transcript is the microphone hearing the speakers. It lives apart
 * from voice.ts because that file cannot be loaded outside a browser — it
 * reaches for the microphone, the VAD and speech synthesis on import — and
 * this is exactly the logic that needs tests: it has been broken, by small and
 * reasonable-looking edits, more than once. Russian and English both live
 * here; lang.ts decides which one the microphone is listening in.
 */

// ---------------------------------------------------------------------------
// His name
// ---------------------------------------------------------------------------

/**
 * His name, and the only wake phrase.
 *
 * The optional prefix is genuinely optional: addressing him by name alone is
 * correct, and during an answer "Jarvis" on its own is the natural way to cut
 * in. The negative lookahead keeps possessives ("Jarvis's job") from waking him.
 *
 * The alternates are not padding. "Jarvis" is not in a general dictation
 * model's high-frequency vocabulary, and Chrome routinely returns Travis,
 * Jervis, Jarvys or Java's for a perfectly clear utterance — every one of which
 * used to be silently discarded, so the wake word "just didn't work" with no
 * indication why. Better a rare false wake than a name that does not answer.
 */
const WAKE_LATIN =
  "\\b(?:hey|hi|ok|okay|yo)?\\s*(?:jarvis|jarvys|jervis|jarvis's|travis|jarviss|java's|jarv)\\b(?!'s)"

/**
 * The same name as Russian dictation hands it back.
 *
 * `\b` is no help on this half. JavaScript defines a word boundary over
 * [A-Za-z0-9_], so next to a Cyrillic letter it asserts the opposite of what it
 * reads — explicit lookaround over the Cyrillic range does the job instead.
 *
 * The alternates matter more here than in English. "Джарвис" is not in the
 * dictation vocabulary at all, so Chrome picks a neighbour, and it rarely picks
 * the same one twice.
 */
const WAKE_CYRILLIC =
  '(?<![а-яё])(?:эй|привет|окей|ок|слушай)?\\s*(?:джарвис|джарвиз|джарвес|джарвик|джарви|жарвис|чарвис|дживс)(?![а-яё])'

/**
 * Both scripts, always. Which one the microphone produces depends on
 * SPEECH_LANG, but answering to his own name in either costs nothing and spares
 * anyone switching languages a wake word that quietly stops working.
 */
export const WAKE = new RegExp(`${WAKE_LATIN}|${WAKE_CYRILLIC}`, 'i')

/** Everything after the wake phrase, which is usually the actual command. */
export function afterWake(text: string): string {
  const m = WAKE.exec(text)
  if (!m) return ''
  return text
    .slice(m.index + m[0].length)
    .replace(/^[\s,.:;!?-]+/, '')
    .trim()
}

// ---------------------------------------------------------------------------
// When a sentence is finished
// ---------------------------------------------------------------------------

/**
 * Ending on one of these means the sentence is not over, whatever the silence
 * says. Function words only: they are closed-class, so the list is complete in
 * a way a content-word list could never be, and none of them is a plausible
 * last word of a real request.
 */
const CONTINUES =
  /\b(and|or|but|so|because|since|if|when|while|that|which|who|whose|to|of|in|on|at|by|for|with|from|about|into|onto|over|under|between|through|the|a|an|my|your|his|her|its|our|their|is|are|was|were|be|been|do|does|did|have|has|had|can|could|would|should|will|shall|might|must|like|than|then|as|very|really|just|some|any|all|both|either|neither)$/i

/**
 * The same closed class in Russian.
 *
 * Tested against a single word, and anchored rather than bounded: `\b` is
 * defined over [A-Za-z0-9_], so against a Cyrillic word it asserts the
 * opposite of what it reads and the whole list never matches. Without this the
 * hold is 250ms for every Russian sentence, so any pause for thought cuts the
 * sentence off and sends the half of it that arrived.
 */
const CONTINUES_RU =
  /^(?:и|а|но|или|да|что|чтобы|если|когда|пока|как|где|куда|откуда|про|для|из|от|до|по|за|над|под|при|без|через|с|со|в|во|на|об|о|у|к|ко|это|этот|эта|эти|мой|моя|мои|твой|твоя|наш|наша|его|её|их|был|была|было|были|быть|есть|могу|можешь|может|надо|нужно|давай|очень|просто|тоже|ещё|еще|уже|самый|самая|какой|какая|какие|который|которая|которые|чем|тем|то|та|тот|те|пожалуйста|мне|нам|тебе|вам|все|всё|весь|вся|мои|наши)$/i

/** Either language's version of "not finished yet". */
export function continuesThought(word: string): boolean {
  return CONTINUES.test(word) || CONTINUES_RU.test(word)
}

/** Trailing punctuation a transcriber emits mid-thought. */
const TRAILS = /[,;:–—-]$/


/**
 * A quiet gap this long with a finished-looking sentence ends the turn.
 *
 * Small on purpose: by the time a transcript reaches the assembler the detector
 * has already sat through SILENCE_MS of quiet and the transcriber has taken its
 * own few hundred milliseconds, so roughly a second of real silence has passed
 * already. All this window has to catch is someone drawing breath to add one
 * more clause. Making it generous here is what would make every ordinary
 * question feel slow.
 */
export const SETTLE_MS = 250
/** ...and this long when the sentence is plainly unfinished. */
export const CONTINUE_MS = 1600
/**
 * Nothing is held longer than this in total. A ceiling rather than a timer:
 * without it, someone who ends every clause on "and" could hold a turn open
 * for ever, and the assistant would look like it had stopped listening.
 */
export const MAX_HOLD_MS = 6000

/**
 * How long to keep waiting, given what has been said so far.
 * 0 means "this is a complete thought, send it now".
 */
export function holdFor(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return CONTINUE_MS
  // An explicit terminator is the speaker telling us they are done.
  if (/[.!?]$/.test(text)) return 0
  if (TRAILS.test(text.trim())) return CONTINUE_MS
  if (continuesThought(words[words.length - 1])) return CONTINUE_MS
  // One or two words is usually the start of something, not the whole of it —
  // except for the short commands that genuinely are complete.
  if (words.length <= 2 && !cutsThrough(text)) return CONTINUE_MS
  return SETTLE_MS
}

/**
 * A transcript as the comparison sees it: one entry per word, with the word
 * lowercased and stripped to letters and digits, and the original spelling
 * kept beside it for output. Comparing on the key is what lets "What time is
 * it?" be recognised as the start of "What time is it in Tokyo?" — the
 * transcriber punctuates every final result, so the raw strings never match.
 */
type Token = { raw: string; key: string }
const tokens = (s: string): Token[] =>
  s
    .trim()
    .split(/\s+/)
    .map((raw) => ({ raw, key: raw.toLowerCase().replace(/[^\p{L}\p{M}\p{N}']+/gu, '') }))
    .filter((t) => t.key)

const startsWithKeys = (list: Token[], prefix: Token[]) =>
  prefix.length <= list.length && prefix.every((t, i) => t.key === list[i].key)

/**
 * Join a new transcript onto what is held, without repeating the overlap.
 *
 * A transcriber does not only append. It re-emits: "what's the weather"
 * becomes "what's the weather in London tomorrow" a moment later, as a fresh
 * final result containing everything it already sent. Concatenating blindly
 * doubles the opening words and the model is asked about "what's the weather
 * what's the weather in London" — so a transcript that extends what is held
 * replaces it, and a partial overlap is stitched at the seam.
 */
export function mergeTranscript(held: string, incoming: string): string {
  if (!held) return incoming
  const a = tokens(held)
  const b = tokens(incoming)
  if (!a.length) return incoming
  if (!b.length) return held
  // A re-emission of the same thought, longer or identical.
  if (startsWithKeys(b, a)) return incoming
  // The same thought again, shorter — what is held already ends with it.
  if (b.length <= a.length && startsWithKeys(a.slice(a.length - b.length), b)) return held
  // The tail of what is held is the head of what arrived: stitch, don't repeat.
  // At least four letters of overlap, so a shared "in" or "the" does not
  // swallow a real continuation.
  for (let k = Math.min(a.length, b.length); k >= 1; k--) {
    const tail = a.slice(a.length - k)
    if (tail.map((t) => t.key).join('').length >= 4 && startsWithKeys(b, tail)) {
      const lead = held.trim().replace(/[\s.!?,;:…]+$/u, '')
      return `${lead} ${b.slice(k).map((t) => t.raw).join(' ')}`.replace(/\s+/g, ' ').trim()
    }
  }
  return `${held} ${incoming}`.replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// Hearing himself
// ---------------------------------------------------------------------------

// Cyrillic has to survive this. Stripping it leaves an empty bag of words,
// isEcho reads "nothing was said" as proof of an echo, and every Russian
// sentence spoken while he is talking is silently discarded as his own voice.
export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Short words that must always cut through, even when they collide with what
 * he happens to be saying. Suppressing "stop" because he just said "stop"
 * would be the single most infuriating failure this file could have.
 */
const OVERRIDE =
  /\b(stop|wait|jarvis|cancel|enough|quiet|hold on|shut up|never ?mind|forget it|no)\b/i

/**
 * The same list in Russian, with lookaround instead of `\b` for the same
 * reason as the wake word. "Стоп" has to cut through his own voice exactly as
 * "stop" does, or the only way to interrupt him is to speak English.
 */
const OVERRIDE_RU =
  /(?<![а-яё])(?:стоп|стой|хватит|довольно|отмена|отмени|тихо|молчи|замолчи|подожди|погоди|джарвис|нет|не надо|забудь|неважно)(?![а-яё])/i

/** Must this get through whatever else is happening? */
export function cutsThrough(text: string): boolean {
  return OVERRIDE.test(text) || OVERRIDE_RU.test(text)
}

/**
 * Words too common to be evidence of anything.
 *
 * This set is the difference between a usable filter and an infuriating one.
 * "What about the second one?" is a perfectly ordinary follow-up, and every
 * word in it is likely to appear somewhere in the answer it follows — so a
 * naive bag-of-words match suppresses the user's real question as an echo.
 * Only distinctive words count as proof he is hearing himself.
 */
const STOP = new Set(
  ('a an the and or but so of to in on at by for with from is are was were be ' +
    'it its this that these those i you he she we they me him her them my your ' +
    'our their what which who how why when where do does did can could would ' +
    'should will shall not no yes if then than as about into over under out up ' +
    'down one two three first second third now here there just very really got ' +
    'get have has had say said tell me okay ok well right ' +
    // The Russian half. Without it every ordinary Russian word counts as
    // distinctive, so a follow-up that naturally repeats his own phrasing is
    // taken for an echo of it.
    'и в во не что он на я с со как а то все всё она так его но да ты к у же ' +
    'вы за бы по только её ее мне было вот от меня ещё еще нет о из ему ' +
    'теперь когда даже ну вдруг ли если уже или ни быть был него до вас ' +
    'опять уж вам ведь там потом себя ничего ей может они тут где есть надо ' +
    'ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под ' +
    'будет тогда кто этот этого того потому какой совсем ним здесь этом один ' +
    'почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при ' +
    'наконец два об другой хоть после над больше тот через эти нас про всего ' +
    'них какая много разве три эту моя хорошо свою этой перед иногда лучше ' +
    'чуть том нельзя такой им более всегда конечно всю между скажи ' +
    'расскажи пожалуйста спасибо хорошо ладно').split(' '),
)

/**
 * Enough of a word to recognise it through a different ending.
 *
 * The comparison below is exact, which is fine for English and wrong for a
 * language that inflects everything: he says "внимания", the recogniser
 * returns "внимание", and the two count as different words. Enough of those
 * and his own answer stops looking like an echo. Truncating to a common prefix
 * is crude, but it is the whole of the morphology that matters here — two
 * words sharing five letters are the same word often enough, and the 0.6
 * threshold absorbs the rest.
 */
const stem = (w: string) => (w.length > 5 ? w.slice(0, 5) : w)

/**
 * Is this the microphone hearing the speakers?
 *
 * Compared as bags of words rather than by string distance: the recogniser
 * mangles its own playback badly enough that a substring match rarely holds,
 * but the *words* survive.
 */
export function looksLikeEcho(heard: string, spoken: string): boolean {
  if (!spoken) return false
  if (cutsThrough(heard)) return false

  const all = norm(heard).split(' ').filter(Boolean)
  if (!all.length) return true

  const mine = new Set(norm(spoken).split(' ').map(stem))
  const content = all.filter((w) => !STOP.has(w))

  // Nothing distinctive was said at all, so there is no strong evidence either
  // way. Demand a total match before discarding it — the cost of dropping a
  // real question is much higher than the cost of one stray echo getting in.
  if (content.length < 2) {
    if (all.length < 2) return false
    return all.every((w) => mine.has(stem(w)))
  }

  let hits = 0
  for (const w of content) if (mine.has(stem(w))) hits++
  return hits / content.length >= 0.6
}
