import type { MockChat, MockMessage } from './types'

/**
 * Message stamps are real ISO datetimes: the screen formats them with
 * `Intl.DateTimeFormat` (`src/view/stamp.ts`) — today as `19:31`, another day as
 * `Nov 24 · 18:02`. No display strings in the data.
 *
 * "Today" is the day this module is loaded, so the demo ages correctly.
 */
const LOADED = new Date()

function stampAt(hhmm: string, daysAgo = 0): string {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(LOADED)
  d.setDate(d.getDate() - daysAgo)
  d.setHours(h ?? 0, m ?? 0, 0, 0)
  return d.toISOString()
}

/**
 * v0.1 mock data. No connections: all of Telegram is here.
 *
 * Demo content is not localized (the language of a conversation, not of the
 * interface): the ru strings in the mocks are a Cyrillic check on the G2 screen,
 * see i18n-strings.md §8.
 * Katya deliberately has no reply options — that is how the NO REPLIES screen
 * becomes reachable.
 *
 * 6 chats: the CHATS window takes all the room down to the footer, and with 6
 * rows it is visible that the list scrolls/clips instead of "ending after the
 * third". MOM and DENIS have 4 messages each: a check of the 1/4 counter and of
 * cyclic paging.
 */

export const MOCK_CHATS: MockChat[] = [
  {
    id: 'ivan',
    person: 'Ivan',
    project: 'Project',
    messages: [
      {
        id: 'ivan-1',
        at: stampAt("19:31"),
        text: 'He wants to move the meeting to 18:00.',
        replies: ['Yes, 18:00 works', 'Suggest another time', 'Not today, sorry'],
      },
      {
        id: 'ivan-2',
        at: stampAt("19:35"),
        text: 'Quick heads-up before tomorrow: the client moved the review to 16:00, so our sync slides to 18:00 instead of 17:00. I have re-booked the room and updated the invite, but please double-check your calendar. Anna will join for the first fifteen minutes to walk through the numbers, and after that I would like us to agree on the final scope for the pilot. If 18:00 does not work for you, say the word and I will push it to Thursday morning.',
        summary:
          'Client moved the review to 16:00, sync slides to 18:00. Anna joins for the numbers, then we agree on pilot scope. Alternative: Thursday morning.',
        replies: ['18:00 works for me', 'Thursday morning is better', 'Need to check, reply soon'],
      },
    ],
  },
  {
    id: 'mom',
    person: 'Mom',
    messages: [
      {
        id: 'mom-1',
        at: stampAt("18:02", 1),
        text: 'Приедешь на ужин в воскресенье?',
        replies: ['Приеду!', 'Буду ближе к 19:00', 'Не смогу, извини'],
      },
      {
        id: 'mom-2',
        at: stampAt("18:14", 1),
        text: 'Оля тоже придёт, захвати десерт',
        replies: ['Хорошо, захвачу', 'Оля не любит сладкое'],
      },
      {
        id: 'mom-3',
        at: stampAt("18:20"),
        text: 'И не забудь про мой рецепт, я скинула',
        replies: ['Помню', 'Скинь ещё раз'],
      },
      {
        id: 'mom-4',
        at: stampAt("18:31"),
        text: 'Жду к семи, не опаздывай',
        replies: ['Буду вовремя', 'Могу опоздать на полчаса'],
      },
    ],
  },
  {
    id: 'katya',
    person: 'Катя',
    messages: [
      {
        // Cyrillic sample from i18n-strings.md §8 — the first task after the mockup is accepted.
        id: 'katya-1',
        at: stampAt("18:05"),
        text: 'Привет, как дела? Ёё Йй Ъъ Ыы Ээ Юю Яя',
        replies: [],
      },
      {
        // Mixed string from the same sample.
        id: 'katya-2',
        at: stampAt("18:47"),
        text: 'Встречу переносим на 18:00?',
        replies: ['Да, 18:00 подойдёт', 'Давай лучше в 19:00', 'Не сегодня'],
      },
    ],
  },
  {
    id: 'denis',
    person: 'Denis',
    project: 'Design',
    messages: [
      {
        id: 'denis-1',
        at: stampAt("17:05"),
        text: 'Отправил тебе новую сетку экрана.',
        replies: ['Посмотрю вечером', 'Спасибо, гляну'],
      },
      {
        id: 'denis-2',
        at: stampAt("17:12"),
        text: 'Там поменялись отступы и высота подвала, проверь на очках.',
        replies: ['Ок, проверю', 'Что именно поменялось?'],
      },
      {
        id: 'denis-3',
        at: stampAt("17:20"),
        text: 'Если влезет не всё, лучше подвинуть подвал, чем резать текст.',
        replies: ['Согласен', 'Обсудим завтра'],
      },
      {
        id: 'denis-4',
        at: stampAt("17:33"),
        text: 'Список чатов теперь можно растянуть до подвала. Проверь, как это выглядит, и скажи, если четвёртый чат обрезается слишком сильно.',
        replies: ['Проверю', 'Ок'],
      },
    ],
  },
  {
    id: 'work',
    person: 'Work',
    project: 'Team',
    messages: [
      {
        id: 'work-1',
        at: stampAt("16:40"),
        text: 'Созвон в 10:00, ссылка в календаре.',
        replies: ['Буду', 'Не смогу, перенесём?'],
      },
    ],
  },
  {
    id: 'anna',
    person: 'Anna',
    messages: [
      {
        id: 'anna-1',
        at: stampAt("16:12"),
        text: 'Скинь, пожалуйста, финальную версию.',
        replies: ['Сейчас пришлю', 'Чуть позже'],
      },
      {
        id: 'anna-2',
        at: stampAt("16:30"),
        text: 'Спасибо! Всё получила.',
        replies: ['Отлично', 'Если что — пиши'],
      },
    ],
  },
]

/** "Check again" on an empty CHATS yields these messages one at a time. */
export const MOCK_INBOX: { chatId: string; message: MockMessage }[] = [
  {
    chatId: 'mom',
    message: {
      id: 'mom-5',
      at: stampAt("19:44"),
      text: 'Оля тоже придёт, захвати десерт',
      replies: ['Хорошо, захвачу', 'Оля не любит сладкое'],
    },
  },
  {
    chatId: 'ivan',
    message: {
      id: 'ivan-3',
      at: stampAt("19:46"),
      text: 'Client confirmed 18:00, see you tomorrow.',
      replies: ['Great, see you then', 'Perfect'],
    },
  },
]

/** Default text for the quick reply (set in the WebView; a constant in v0.1). */
export const MOCK_QUICK_REPLY = "I'll reply later, busy now"

/** Recognition mock: a normal recording. */
export const MOCK_HEARD_TEXT = 'Yes, 18:00 works, but only if we start on time.'

/** Recognition mock: a long transcript, so the HEARD scrolling window is reachable. */
export const MOCK_HEARD_LONG =
  'So, about tomorrow: I can make the earlier slot, but I need to leave by seven. ' +
  'If we keep it short, thirty minutes at most, we can cover the plan and the numbers. ' +
  'So, about tomorrow: I can make the earlier slot, but I need to leave by seven. ' +
  'If we keep it short, thirty minutes at most, we can cover the plan and the numbers.'
