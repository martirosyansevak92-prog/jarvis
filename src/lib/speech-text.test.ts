/**
 * The cases that bit during the Russian voice work, kept so they cannot bite
 * again. Every one of these was a real failure at some point: a word boundary
 * that does not exist for Cyrillic, a normaliser that threw the whole language
 * away, an echo check that compared a paragraph against one sentence.
 *
 *   npm test
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  WAKE,
  afterWake,
  holdFor,
  mergeTranscript,
  cutsThrough,
  looksLikeEcho,
  norm,
  SETTLE_MS,
  CONTINUE_MS,
} from './speech-text'

describe('wake word', () => {
  const wakes: Array<[string, string]> = [
    ['Эй, Джарвис, какая погода?', 'какая погода?'],
    ['Джарвис, включи музыку', 'включи музыку'],
    ['джарвиз сделай скриншот', 'сделай скриншот'],
    ['Привет Джарвис', ''],
    ['ДЖАРВИС', ''],
    ['слушай джарвис найди статью', 'найди статью'],
    ['Hey Jarvis, what is the weather?', 'what is the weather?'],
    ['Jarvis', ''],
  ]
  for (const [phrase, command] of wakes) {
    test(`wakes on "${phrase}"`, () => {
      assert.ok(WAKE.test(phrase))
      assert.equal(afterWake(phrase), command)
    })
  }

  // `\b` is defined over ASCII, so without explicit lookaround these would
  // match — the name inside a longer word, and the name with a case ending.
  for (const phrase of ['поджарвиси это', 'джарвисом интересуюсь', 'сегодня хорошая погода']) {
    test(`sleeps through "${phrase}"`, () => {
      assert.equal(WAKE.test(phrase), false)
    })
  }
})

describe('norm', () => {
  test('keeps Cyrillic', () => {
    assert.equal(norm('Какая сегодня погода'), 'какая сегодня погода')
  })
  test('keeps Latin and digits, drops punctuation', () => {
    assert.equal(norm("What's the time, 7pm?"), "what's the time 7pm")
  })
})

describe('holdFor — when a sentence is finished', () => {
  test('a terminator sends at once', () => {
    assert.equal(holdFor('открой почту.'), 0)
  })
  test('a finished Russian sentence settles quickly', () => {
    assert.equal(holdFor('какая сегодня погода'), SETTLE_MS)
  })
  for (const unfinished of ['найди погоду и', 'открой браузер чтобы', 'Найди мне пожалуйста', 'покажи мне']) {
    test(`waits after "${unfinished}"`, () => {
      assert.equal(holdFor(unfinished), CONTINUE_MS)
    })
  }
  test('one word is usually a start, not a whole', () => {
    assert.equal(holdFor('сегодня'), CONTINUE_MS)
  })
  test('but a one-word command is complete', () => {
    assert.equal(holdFor('стоп'), SETTLE_MS)
  })
})

describe('mergeTranscript — a re-emitted transcript does not repeat itself', () => {
  test('a longer re-emission replaces what is held', () => {
    assert.equal(
      mergeTranscript('Найди мне пожалуйста', 'Найди мне пожалуйста все записи за неделю'),
      'Найди мне пожалуйста все записи за неделю',
    )
  })
  test('the same text again is a no-op', () => {
    assert.equal(mergeTranscript('открой почту', 'открой почту'), 'открой почту')
  })
  test('a partial overlap is stitched at the seam', () => {
    assert.equal(mergeTranscript('какая сегодня', 'сегодня погода в Ереване'), 'какая сегодня погода в Ереване')
  })
  test('a genuine continuation is appended', () => {
    assert.equal(mergeTranscript('открой почту', 'и календарь'), 'открой почту и календарь')
  })
})

describe('cutsThrough — words that interrupt him', () => {
  for (const word of ['стоп', 'хватит', 'подожди', 'джарвис', 'stop', 'never mind']) {
    test(`"${word}" cuts through`, () => assert.ok(cutsThrough(word)))
  }
  test('the name inside another word does not', () => {
    assert.equal(cutsThrough('поставь стопку книг'), false)
  })
})

describe('looksLikeEcho — hearing himself through the speakers', () => {
  const heard = 'на экране шесть писем за сегодня сэр внимание просят два у Apple сменился адрес'
  const lastSentence = 'Внимания просят два: у Apple сменился адрес.'
  const wholeReply = 'На экране шесть писем за сегодня, сэр. Внимания просят два: у Apple сменился адрес.'

  test('a multi-sentence answer is not recognised against its last sentence alone', () => {
    // This is the failure that made him answer himself: tts.ts now keeps the
    // whole recent utterance for exactly this reason.
    assert.equal(looksLikeEcho(heard, lastSentence), false)
  })
  test('…but is, against the whole recent reply', () => {
    assert.equal(looksLikeEcho(heard, wholeReply), true)
  })
  test('survives a different case ending', () => {
    assert.equal(looksLikeEcho('жду указа', 'Жду указаний, сэр.'), true)
  })
  test('Russian speech while he talks is not thrown away', () => {
    assert.equal(looksLikeEcho('какая сегодня погода в Ереване', 'Все системы в строю, сэр.'), false)
  })
  test('a real question that shares a word is not an echo', () => {
    assert.equal(looksLikeEcho('вытащи на экран последние sms из gmail', wholeReply), false)
    assert.equal(looksLikeEcho('а что там по Apple было ещё вчера и позавчера', lastSentence), false)
  })
  test('silence means nothing to echo', () => {
    assert.equal(looksLikeEcho('какая сегодня погода', ''), false)
  })
  test('a command always gets through', () => {
    assert.equal(looksLikeEcho('стоп', wholeReply), false)
  })
})
