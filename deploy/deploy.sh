#!/usr/bin/env bash
# Разворачивает JARVIS на сервере. Ничего не запускает — только готовит.
#
#   ./deploy.sh логин@адрес
#
# Проверяет Node и Claude Code, клонирует (или обновляет) репозиторий
# и ставит зависимости. Логин в Claude Code нужно сделать вручную —
# это интерактивный вход в аккаунт.

set -euo pipefail

REMOTE="${1:-}"
REPO="${JARVIS_REPO:-https://github.com/adewaskar/jarvis.git}"
DIR="${JARVIS_DIR:-\$HOME/jarvis}"
SSH_PORT="${JARVIS_SSH_PORT:-22}"

if [ -z "$REMOTE" ]; then
  echo "Использование: $0 логин@адрес" >&2
  exit 2
fi

say() { printf '\n\033[36m==\033[0m %s\n' "$1"; }

say "Проверяю связь с $REMOTE"
if ! ssh -p "$SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10 "$REMOTE" 'echo ok; uname -sr'; then
  echo "SSH по ключу не прошёл. Прокинь ключ: ssh-copy-id $REMOTE" >&2
  exit 1
fi

say "Проверяю окружение на сервере"
checked=0
ssh -p "$SSH_PORT" "$REMOTE" bash -s <<'REMOTE_CHECK' || checked=$?
set -u
problems=0
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -ge 20 ] 2>/dev/null; then
    echo "  ok   Node.js $(node -v)"
  else
    echo "  !    Node.js $(node -v) — нужен 20 или новее"; problems=1
  fi
else
  echo "  !    Node.js не установлен (нужен 20+)"; problems=1
fi

if command -v claude >/dev/null 2>&1; then
  echo "  ok   Claude Code $(claude --version 2>/dev/null | head -1)"
else
  echo "  !    Claude Code не установлен: npm install -g @anthropic-ai/claude-code"; problems=1
fi

if [ -f "$HOME/.claude.json" ]; then
  echo "  ok   ~/.claude.json есть (логин, судя по всему, выполнен)"
else
  echo "  ·    логин в Claude Code ещё не выполнен — код поставить можно,"
  echo "       но перед запуском нужно: ssh -t <этот сервер> claude auth login"
fi

if command -v tmux >/dev/null 2>&1; then
  echo "  ok   tmux есть — запуск переживёт отключение"
else
  echo "  ·    tmux нет; поставь его, иначе процесс умрёт вместе с ssh-сессией"
fi

exit $problems
REMOTE_CHECK

# Знак '!' ставят только Node и Claude Code — без них ставить код бессмысленно.
# Отсутствие логина помечено точкой: это не мешает развернуть код.
if [ "$checked" -ne 0 ]; then
  echo
  echo "Сначала поправь пункты со знаком '!' выше, потом запусти deploy.sh снова." >&2
  exit 1
fi

say "Разворачиваю код"
ssh -p "$SSH_PORT" "$REMOTE" "REPO='$REPO' DIR=\"$DIR\" bash -s" <<'REMOTE_DEPLOY'
set -eu
if [ -d "$DIR/.git" ]; then
  echo "  репозиторий уже есть — обновляю"
  git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi
cd "$DIR"
npm install
echo "  зависимости установлены в $DIR"
REMOTE_DEPLOY

say "Применяю русскую голосовую правку"
# Один патч на все местные правки: привязка моста к loopback (апстрим
# слушает все интерфейсы) и русский голосовой контур — распознавание,
# голос, слово-активатор и язык ответа.
# Патч делает язык настраиваемым (VITE_SPEECH_LANG, по умолчанию ru-RU) и учит
# слово-активатор кириллице. Применяется заново после каждого git pull;
# если уже применён — шаг молча пропускается.
scp -P "$SSH_PORT" -q "$(dirname "$0")/ru-voice.patch" "$REMOTE:/root/ru-voice.patch"
ssh -p "$SSH_PORT" "$REMOTE" "DIR=\"$DIR\" bash -s" <<'REMOTE_RU'
set -eu
cd "$DIR"
if git apply --check --reverse /root/ru-voice.patch 2>/dev/null; then
  echo "  уже применён"
elif git apply --check /root/ru-voice.patch 2>/dev/null; then
  git apply /root/ru-voice.patch
  echo "  применён"
else
  echo "  НЕ ЛОЖИТСЯ на текущий код — апстрим изменился, патч нужно пересобрать" >&2
  exit 1
fi
REMOTE_RU

say "Готово"
cat <<MSG
Код на сервере, зависимости стоят. Дальше:

  1) запусти на сервере:   ./deploy/run.sh $REMOTE
  2) открой туннель с Mac: ./deploy/tunnel.sh $REMOTE
  3) в Chrome:             http://localhost:5173
MSG
