#!/usr/bin/env bash
# Запускает JARVIS на сервере внутри tmux, чтобы он жил после отключения.
#
#   ./run.sh логин@адрес            # только чтение
#   ./run.sh логин@адрес --writes   # разрешить действия (шелл, файлы) НА СЕРВЕРЕ
#
# Порт моста на сервере задаётся JARVIS_BRIDGE_PORT (по умолчанию 8790).
# Браузер на Mac всё равно обращается к localhost:8787 — туннель сопоставляет
# порты, поэтому фронтенд настраивать не нужно.

set -euo pipefail

REMOTE="${1:-}"
MODE="${2:-}"
DIR="${JARVIS_DIR:-\$HOME/jarvis}"
BRIDGE_PORT="${JARVIS_BRIDGE_PORT:-8790}"
SESSION=jarvis
SSH_PORT="${JARVIS_SSH_PORT:-22}"

if [ -z "$REMOTE" ]; then
  echo "Использование: $0 логин@адрес [--writes]" >&2
  exit 2
fi

ARGS=""
if [ "$MODE" = "--writes" ]; then
  ARGS=" -- --writes"
  echo "ВНИМАНИЕ: режим writes — JARVIS сможет запускать команды и менять файлы на сервере."
elif [ -n "$MODE" ]; then
  echo "Неизвестный аргумент: $MODE (ожидался --writes)" >&2
  exit 2
fi

ssh -p "$SSH_PORT" "$REMOTE" "DIR=\"$DIR\" SESSION='$SESSION' ARGS='$ARGS' BRIDGE_PORT='$BRIDGE_PORT' bash -s" <<'REMOTE_RUN'
set -eu
export PATH=/usr/local/bin:$PATH
LOG="$HOME/jarvis.log"

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux не установлен — без него процесс умрёт вместе с ssh-сессией." >&2
  exit 1
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "  сессия '$SESSION' уже идёт — перезапускаю"
  tmux kill-session -t "$SESSION"
  sleep 2
fi

# Проверяем порт ПОСЛЕ остановки своей сессии: иначе скрипт увидит собственный
# предыдущий запуск и откажется перезапускаться. Теперь сюда доходит только
# по-настоящему чужой процесс.
if ss -lnt 2>/dev/null | grep -q ":$BRIDGE_PORT "; then
  echo "Порт $BRIDGE_PORT занят чужим процессом:" >&2
  ss -lntp 2>/dev/null | grep ":$BRIDGE_PORT " | sed 's/^/  /' >&2
  echo "Выбери другой: JARVIS_BRIDGE_PORT=8791 ./run.sh ..." >&2
  exit 1
fi

: > "$LOG"
tmux new-session -d -s "$SESSION" -c "$DIR" \
  "JARVIS_BRIDGE_PORT=$BRIDGE_PORT npm start$ARGS 2>&1 | tee -a '$LOG'"
sleep 8

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "Сессия сразу умерла." >&2
  if [ -s "$LOG" ]; then
    echo "Последние строки лога:" >&2
    tail -25 "$LOG" | sed 's/^/  /' >&2
  else
    echo "Лог пуст — процесс упал до первой записи. Посмотри причину напрямую:" >&2
    echo "  ssh <сервер> 'cd ~/jarvis && JARVIS_BRIDGE_PORT=$BRIDGE_PORT npm start'" >&2
  fi
  exit 1
fi

echo "  запущено в tmux-сессии '$SESSION', мост на порту $BRIDGE_PORT"
echo
echo "  последние строки:"
tmux capture-pane -p -t "$SESSION" | grep -v '^$' | tail -12 | sed 's/^/    /'
REMOTE_RUN

cat <<MSG

Лог:          ssh -p "$SSH_PORT" $REMOTE 'tail -f ~/jarvis.log'
Сессия:       ssh -p "$SSH_PORT" -t $REMOTE 'tmux attach -t jarvis'   (выход: Ctrl-B, затем D)
Остановить:   ssh -p "$SSH_PORT" $REMOTE 'tmux kill-session -t jarvis'

Туннель с Mac:  JARVIS_BRIDGE_PORT=$BRIDGE_PORT ./deploy/tunnel.sh $REMOTE
MSG
