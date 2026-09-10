#!/bin/sh
# entrypoint.sh -- the one thing a coding sandbox does (CODE-1, docs/CODE.md).
#
# The relay creates the container, pipes the model credential into /run/code/env, and starts it.
# From there this script is the whole task: read the instructions out of the mounted directory, run
# the agent against the proxy, write the summary and the transcript beside the files it produced, and
# exit with a code the relay reads.
#
# /bin/sh, not bash: the image has dash and there is nothing here that needs more. Every expansion is
# quoted, because a task title and a set of instructions are a customer's own words.
set -eu

TASK_DIR="${TASK_DIR:-/task}"
TASK_FILE="$TASK_DIR/task.json"
CRED="${CODE_CRED_FILE:-/run/code/env}"
SUMMARY="$TASK_DIR/SUMMARY.md"
TRANSCRIPT="$TASK_DIR/agent.json"
LOG="$TASK_DIR/agent.log"

# THE CREDENTIAL, AND THEN NOT. It is sourced and truncated in the same breath, so a task that later
# runs `cat /run/code/env` -- and a coding agent told to look around really does things like that --
# finds an empty file. Truncate rather than delete: an unlink on a read-only bind mount fails and
# would take the task with it, and an empty file is the same outcome.
if [ -r "$CRED" ]; then
  # shellcheck disable=SC1090
  . "$CRED"
  : > "$CRED" 2>/dev/null || true
fi
export ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-}"
if [ -z "$ANTHROPIC_AUTH_TOKEN" ]; then
  printf 'the model credential never arrived, so no work was done\n' > "$SUMMARY"
  exit 78
fi

if [ ! -r "$TASK_FILE" ]; then
  printf 'there were no instructions in the task directory, so no work was done\n' > "$SUMMARY"
  exit 78
fi

# The prompt comes out of the FILE and never off a command line: any process on a machine can read
# another's arguments, and instructions are a customer's own words. jq is in the image for this.
PROMPT="$(jq -r '.instructions // ""' "$TASK_FILE")"
TITLE="$(jq -r '.title // ""' "$TASK_FILE")"
if [ -z "$PROMPT" ]; then
  printf 'the instructions were empty, so no work was done\n' > "$SUMMARY"
  exit 78
fi

MAX_TURNS="${CODE_MAX_TURNS:-120}"

# WHAT THE AGENT IS TOLD ON TOP OF THE TASK. Three facts it cannot work out for itself and will
# otherwise waste its turns discovering: there is no internet, this directory is the deliverable, and
# a summary is part of the job.
PREAMBLE="You are working in $TASK_DIR on a machine with no internet access at all.
You cannot clone a repository, install a package, or fetch anything. Everything you need is either
already in $TASK_DIR or part of python3, node and the standard library.
Write every file you produce into $TASK_DIR. When you are finished, write $SUMMARY: a few plain
sentences saying what you did, which files you wrote, how you checked them, and anything you could
not finish. That summary is what the person asking for this work will read.

The task is: $TITLE

$PROMPT"

# `claude -p` is the headless turn. --output-format json so the transcript is machine readable;
# --dangerously-skip-permissions because the container IS the permission boundary and a prompt in a
# headless run is a hang; --max-turns so a looping agent stops at a number instead of at the wall
# clock.
#
# THE EXIT CODE IS NOT A VERDICT ON ITS OWN. Two outcomes this product treats as normal and never
# shows a person as a failure (CODE-8):
#   * the [claude-code:unrecognized_model] line on stderr, which is what the agent always prints
#     against a proxy whose model name is not in its own table. The turn completes.
#   * a --max-turns exit, which means it stopped because it was told how many turns it may take.
# The relay drops the first from the log it shows and reports the second as a finished task whose
# summary says what is unfinished.
# THE PROMPT GOES IN ON STDIN AND THERE IS NO `< /dev/null` ON THIS COMMAND. There was, and it came
# after the pipe, so it won: the agent read an empty stdin and the whole task died on
# "Error: Input must be provided either through stdin or as a prompt argument when using --print".
# Measured on the R750 2026-09-10. A pipe and a redirect cannot both feed one stdin.
#
# The redirect was there so nothing the agent RUNS blocks waiting for a terminal, and it is not
# needed for that: once the agent has read the prompt its stdin is at EOF, and a child process that
# reads EOF gets an answer immediately rather than hanging. The prompt stays on stdin rather than
# becoming an argument because it is the customer's own words and any process can read another's
# argument list (MARKET-17).
set +e
printf '%s' "$PREAMBLE" | claude -p \
  --output-format json \
  --dangerously-skip-permissions \
  --max-turns "$MAX_TURNS" \
  > "$TRANSCRIPT" 2> "$LOG"
CODE=$?
set -e

# The summary is the agent's job, but a task that died before writing one still has to answer the
# person with a sentence rather than with silence.
if [ ! -s "$SUMMARY" ]; then
  {
    printf '# %s\n\n' "${TITLE:-coding task}"
    if [ "$CODE" -eq 0 ]; then
      printf 'The work finished but no summary was written. The files in this directory are the result.\n'
    else
      printf 'The work stopped before it was finished.\n\n'
      printf 'The last thing it printed:\n\n'
      tail -c 2000 "$LOG" 2>/dev/null || true
    fi
  } > "$SUMMARY"
fi

# Readable by the bot, which runs as this same uid and reads these files through its own /workspace.
chmod 0644 "$SUMMARY" "$TRANSCRIPT" "$LOG" 2>/dev/null || true

exit "$CODE"
