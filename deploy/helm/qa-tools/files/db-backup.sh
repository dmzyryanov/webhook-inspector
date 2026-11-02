#!/usr/bin/env bash
# Nightly backup of the application database (D176, issue #67).
#
# Run by the CronJob in templates/db-backup.yaml, from the chart's PostgreSQL
# image, so pg_dump is the server's own version. One run, in this order; a step
# that fails fails the run and leaves no new dump behind, unless the dump was
# already saved and checked, as steps 5 and 6 say:
#
#   1. Free-space guard. The run stops before writing anything when the
#      filesystem holding BACKUP_DIR has less than BACKUP_MIN_FREE_GIB free.
#   2. pg_dump -Fc into a temporary name in BACKUP_DIR, from a snapshot exported
#      by a read-only transaction held open meanwhile. The session and request
#      counts are read in that same snapshot, so a webhook arriving during the
#      run cannot make the check below fail. The rows of the realtime outbox,
#      public.realtime_events, are left out: they matter for seconds, and a
#      restore creates the table empty (D221).
#   3. The dump's sha256, in a temporary file beside it.
#   4. Restore check. A scratch PostgreSQL started inside this pod, listening on
#      a Unix socket only, restores the dump, and its counts must equal the
#      dump's. pg_cron is not loaded there, and the extension and its cron.*
#      rows are left out of the restore, so the expired-session cleanup
#      (migration 006) cannot delete anything before the counts are taken.
#      Production is only read, and after step 2 not at all: its connection
#      settings are removed from the environment.
#   5. Rename to <database>-<UTC timestamp>.dump and .dump.sha256, then delete
#      all but the BACKUP_KEEP newest dumps of exactly that pattern. Nothing
#      else in the directory is touched, and the dump this run saved is never
#      deleted: a dump whose name sorts after it fails the run instead. Once
#      the new dump is saved and its checksum verified, a failure while pruning
#      still fails the run, but the new dump, which has passed its restore
#      check, is kept.
#   6. Off-server copy (D190, issue #89), when BACKUP_OFFSITE_DIR is set. The
#      saved dump is encrypted with gpg to the public key in
#      BACKUP_OFFSITE_RECIPIENT_FILE — this pod holds no private key and cannot
#      decrypt its own copies — and the ciphertext alone is renamed into
#      BACKUP_OFFSITE_DIR, a directory shared with the uploader beside this
#      container (files/db-backup-offsite.mjs), which holds the storage
#      credential, uploads the copy and prunes the bucket. The run waits there
#      for the uploader's answer, `<name>.gpg.result`, so the upload happens
#      while this container is still running. A failed encryption, a failure
#      the uploader reports, or no answer in BACKUP_OFFSITE_WAIT_SECONDS fails
#      the run as `Off-server copy failed: …`; the dump, saved and pruned in
#      step 5, is kept. Without BACKUP_OFFSITE_DIR nothing is encrypted or
#      handed over, and the run ends after step 5.
#
# The log carries the counts and the file name, never a credential: nothing is
# traced (no `set -x`) and the environment is never printed. Of a PostgreSQL
# client's messages only the first line of each is shown — the lines that begin
# with the client's name, and for the scratch server's statements its `ERROR:`
# lines. The continuation lines are left out, because the server's DETAIL and
# CONTEXT there quote rows and keys; a first line can still quote a value, such
# as an input that did not parse. Of gpg's messages the lines that begin `gpg:`
# are shown, which name files and the key. The uploader's answer is another
# container's file: it is read only when it is a regular file — a FIFO would
# hold the read and a symbolic link would read some other file — by a reader in
# the background with 5 seconds to finish, which a stop signal ends like any
# step; only its first two lines are read, within 2048 bytes, and of its
# message only printable ASCII, cut at 600 characters for the log and at 240
# for a failure, which goes into the status file.
#
# Every exit the script can observe — success, a failed step, a stop signal —
# also writes BACKUP_STATUS_FILE when it is set, for the notifier beside it in
# the pod, which sends the outcome to the heartbeat service
# (files/db-backup-notify.mjs, D181): `ok`, or `fail` and the run's own message on the next line — the last
# `fail` message or the stop signal, never a PostgreSQL client's output. It is
# written under a temporary name and renamed, so it is never read half written,
# and made readable by the notifier's uid despite the umask.
#
# Environment:
#   PGHOST, PGPORT, PGUSER, PGDATABASE, PGPASSWORD  the database backed up (libpq)
#   BACKUP_DIR           where the dumps are kept
#   BACKUP_SCRATCH       a writable directory for the scratch server and FIFOs
#   BACKUP_KEEP          how many dumps to keep, default 3
#   BACKUP_MIN_FREE_GIB  free space required before writing, in GiB, default 10
#   BACKUP_STATUS_FILE   where to write the outcome for the notifier; unset, nowhere
#   BACKUP_OFFSITE_DIR             where the uploader takes the encrypted copy;
#                                  unset, no off-server copy
#   BACKUP_OFFSITE_RECIPIENT_FILE  the armored public key the copy is encrypted to
#   BACKUP_OFFSITE_WAIT_SECONDS    how long to wait for the uploader's answer,
#                                  default 300

set -euo pipefail
shopt -s nullglob
umask 077
export LC_ALL=C
# libpq waits for a connection indefinitely by default.
export PGCONNECT_TIMEOUT=${PGCONNECT_TIMEOUT:-30}
# A write to a pipe whose reader has gone fails as a command, which the step
# reports, instead of killing the shell before the cleanup below can run.
trap '' PIPE

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log() { printf '%s %s\n' "$(now)" "$*"; }
# The message of the last failure, for the status file.
failure=
fail() {
  failure=$*
  printf '%s ERROR: %s\n' "$(now)" "$*" >&2
  exit 1
}

# tool_messages <client> <file> [--errors]: the first lines of a PostgreSQL
# client's messages, from its captured stderr: "pg_dump: error: ...",
# "psql:/dev/stdin:2: ERROR: ...". psql prints the server's error for a `-c`
# statement without its own name, as a bare "ERROR:  ..."; --errors keeps
# those too, and is given only for statements on the scratch server. See the
# header on why nothing else from those files is printed.
tool_messages() {
  local pattern="^$1:"
  if [ "${3:-}" = --errors ]; then pattern="$pattern|^ERROR:"; fi
  if [ -s "$2" ]; then
    grep -E "$pattern" "$2" | cut -c1-300 >&2 || true
  fi
}

# What the cleanup needs to know; every exit, a failure or a signal, passes it.
# Set before the settings are checked, so that a wrong setting reports its
# status as well.
status_file=${BACKUP_STATUS_FILE:-}
run_dir=
child_pid=
snap_pid=
server_data=
server_started=0
tmp_dump=
tmp_sum=
new_dump=
new_sum=
saved=0
offsite_tmp=
offsite_file=
offsite_result=

cleanup() {
  local status=$?
  set +e
  trap '' TERM INT HUP
  if [ -n "$child_pid" ]; then
    kill "$child_pid" 2>/dev/null
    wait "$child_pid" 2>/dev/null
  fi
  if [ -n "$snap_pid" ]; then
    # Ends the exporting transaction; the server rolls it back.
    exec 3>&- 4<&-
    kill "$snap_pid" 2>/dev/null
    wait "$snap_pid" 2>/dev/null
  fi
  if [ "$server_started" = 1 ]; then
    pg_ctl -D "$server_data" -m immediate -w stop >/dev/null 2>&1
  fi
  if [ "$saved" != 1 ]; then
    for file in "$tmp_dump" "$tmp_sum" "$new_dump" "$new_sum"; do
      if [ -n "$file" ]; then rm -f -- "$file"; fi
    done
  fi
  # The ciphertext handed to the uploader and its answer, whatever the outcome
  # and whatever stands where the answer belongs.
  for file in "$offsite_tmp" "$offsite_file"; do
    if [ -n "$file" ]; then rm -f -- "$file" 2>/dev/null; fi
  done
  if [ -n "$offsite_result" ]; then rm -rf -- "$offsite_result" 2>/dev/null; fi
  if [ -n "$run_dir" ]; then rm -rf -- "$run_dir"; fi
  if [ "$status" -ne 0 ]; then
    if [ "$saved" = 1 ]; then
      log 'Backup failed after the new dump was saved and checked; that dump is kept'
    else
      log 'Backup failed; no new dump was kept'
    fi
  fi
  report "$status"
  exit "$status"
}

# report <exit status>: the outcome in BACKUP_STATUS_FILE, as the header
# describes. A status file that cannot be written is logged and changes
# nothing: the notifier then reports that the backup ended without an outcome.
report() {
  local outcome=ok message= tmp
  if [ -z "$status_file" ]; then return 0; fi
  if [ "$1" -ne 0 ]; then
    outcome=fail
    message=${failure:-"The backup script exited with status $1"}
    message=${message//[$'\n\r\t']/ }
    message=${message:0:300}
  fi
  tmp=$status_file.tmp.$$
  if ! { printf '%s\n%s\n' "$outcome" "$message" >"$tmp" && chmod 0644 "$tmp" &&
    mv -f -- "$tmp" "$status_file"; } 2>/dev/null; then
    rm -f -- "$tmp" 2>/dev/null
    log "Could not write the status file $status_file"
  fi
}
trap cleanup EXIT
# A pod that is stopped — at the Job's activeDeadlineSeconds, or deleted — gets
# its image's stop signal: containerd, like `docker stop`, honours the image's
# STOPSIGNAL, which for the PostgreSQL image is INT. TERM is handled the same
# way.
stop() {
  failure="Stopped by $1"
  log "$failure"
  exit "$2"
}
trap 'stop SIGTERM 143' TERM
trap 'stop SIGINT 130' INT
trap 'stop SIGHUP 129' HUP

database=${PGDATABASE:-}
backup_dir=${BACKUP_DIR:-}
scratch_root=${BACKUP_SCRATCH:-}
keep=${BACKUP_KEEP:-3}
min_free_gib=${BACKUP_MIN_FREE_GIB:-10}
# Checked in step 6, not here: a wrong off-server setting must not cost the
# night its dump on the node.
offsite_dir=${BACKUP_OFFSITE_DIR:-}
offsite_recipient=${BACKUP_OFFSITE_RECIPIENT_FILE:-}
offsite_wait=${BACKUP_OFFSITE_WAIT_SECONDS:-300}

name_re='^[A-Za-z0-9_]+$'
[[ $database =~ $name_re ]] || fail 'PGDATABASE must name the database, in letters, digits and _'
[ -n "$backup_dir" ] || fail 'BACKUP_DIR is not set'
[ -n "$scratch_root" ] || fail 'BACKUP_SCRATCH is not set'
[[ $keep =~ ^[1-9][0-9]*$ ]] || fail "BACKUP_KEEP must be a whole number from 1, not '$keep'"
[[ $min_free_gib =~ ^[0-9]+$ ]] || fail "BACKUP_MIN_FREE_GIB must be a whole number, not '$min_free_gib'"
[ -d "$backup_dir" ] && [ -w "$backup_dir" ] || fail "$backup_dir is not a writable directory"
[ -d "$scratch_root" ] && [ -w "$scratch_root" ] || fail "$scratch_root is not a writable directory"

# run <output file> <command...>: runs a step in the background and waits for
# it, so that the stop signal — INT or TERM — reaches the trap at once instead
# of after the step ends; the cleanup then stops the step. The step's stdout
# and stderr go to the file. The redirection
# is the step's own, never the function call's: a trap that fires inside a call
# redirected as `run ... >file` would write the cleanup's own lines into that
# file too, and the run would end without saying that it failed.
run() {
  local output=$1 status=0
  shift
  "$@" >"$output" 2>&1 &
  child_pid=$!
  wait "$child_pid" || status=$?
  child_pid=
  return "$status"
}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
[[ $stamp =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "Unexpected time stamp '$stamp'"
name=$database-$stamp.dump
log "Backup of $database from ${PGHOST:-the local socket}:${PGPORT:-5432} into $backup_dir: keep $keep dumps, need $min_free_gib GiB free"

# 1. Free-space guard ---------------------------------------------------------

avail_kib=$(df -P -k "$backup_dir" | awk 'NR == 2 { print $4 }')
[[ $avail_kib =~ ^[0-9]+$ ]] || fail "Could not read the free space of $backup_dir"
avail_gib=$(awk -v kib="$avail_kib" 'BEGIN { printf "%.1f", kib / 1048576 }')
if [ "$avail_kib" -lt $((min_free_gib * 1048576)) ]; then
  fail "Not enough free space: $backup_dir has $avail_gib GiB free, less than the $min_free_gib GiB required. Nothing was written."
fi
log "Free space in $backup_dir: $avail_gib GiB"

run_dir=$(mktemp -d "$scratch_root/db-backup.XXXXXX")

# 2. Dump, with the counts read in the dump's own snapshot --------------------

# The exporting transaction lives in a psql that reads its statements from one
# FIFO and answers into another, so it stays open until pg_dump has finished.
# `-f /dev/stdin` rather than plain stdin: only for a file does psql prefix a
# server error with its own name and the line, "psql:/dev/stdin:2: ERROR: ...",
# which is what tool_messages shows.
mkfifo "$run_dir/snapshot.in" "$run_dir/snapshot.out"
psql -X -q -A -t -w -v ON_ERROR_STOP=1 -f /dev/stdin \
  <"$run_dir/snapshot.in" >"$run_dir/snapshot.out" 2>"$run_dir/snapshot.err" &
snap_pid=$!
exec 3>"$run_dir/snapshot.in" 4<"$run_dir/snapshot.out"
snapshot=
dump_sessions=
dump_requests=
if ! printf '%s\n' \
  'BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;' \
  'SELECT pg_export_snapshot(), (SELECT count(*) FROM public.sessions), (SELECT count(*) FROM public.requests);' \
  >&3 || ! IFS='|' read -r -t 120 -u 4 snapshot dump_sessions dump_requests; then
  tool_messages psql "$run_dir/snapshot.err"
  fail "Could not open a snapshot of $database"
fi
[[ $snapshot =~ ^[0-9A-F]+-[0-9A-F]+-[0-9]+$ && $dump_sessions =~ ^[0-9]+$ && $dump_requests =~ ^[0-9]+$ ]] ||
  fail "Unexpected answer while opening a snapshot of $database"

# A temporary name that the pruning pattern below never matches.
tmp_dump=$backup_dir/.$name.tmp
# Without the outbox's rows (D221): each matters for seconds, and a flood of
# large events could otherwise make the dump, and the snapshot held while it
# runs, as long as that table is large; the snapshot keeps the database from
# reclaiming the rows the backend deletes meanwhile. The table itself is
# dumped, and restores empty.
if ! run "$run_dir/pg_dump.err" pg_dump -Fc -w --snapshot="$snapshot" \
  --exclude-table-data=public.realtime_events -f "$tmp_dump"; then
  tool_messages pg_dump "$run_dir/pg_dump.err"
  fail "pg_dump of $database failed"
fi
# The dump is complete; end the exporting transaction.
printf 'COMMIT;\n' >&3 || true
exec 3>&-
wait "$snap_pid" || true
snap_pid=
exec 4<&-
dump_bytes=$(wc -c <"$tmp_dump" | tr -d ' ')
[ "$dump_bytes" -gt 0 ] || fail 'pg_dump wrote an empty file'
log "Dumped $database in snapshot $snapshot: $dump_sessions sessions, $dump_requests requests, $dump_bytes bytes"

# Nothing below reads production.
unset PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD

# 3. Checksum -----------------------------------------------------------------

sum_line=$(sha256sum "$tmp_dump") || fail 'sha256sum failed'
sha=${sum_line%% *}
[[ $sha =~ ^[0-9a-f]{64}$ ]] || fail 'sha256sum gave no checksum'
tmp_sum=$backup_dir/.$name.sha256.tmp
printf '%s  %s\n' "$sha" "$name" >"$tmp_sum" || fail 'Could not write the checksum file'
log "sha256 $sha"

# 4. Restore check ------------------------------------------------------------

server_data=$run_dir/data
socket_dir=$run_dir/socket
mkdir -m 700 "$socket_dir"
if ! run "$run_dir/initdb.log" initdb -D "$server_data" -U postgres -A trust -E UTF8 \
  --locale=C --no-sync --no-instructions; then
  cat "$run_dir/initdb.log" >&2
  fail 'initdb of the scratch server failed'
fi
# No TCP listener and no shared_preload_libraries: pg_cron is not loaded. The
# rest makes a throwaway server cheap: no fsync, minimal WAL, which lets the
# single-transaction restore skip WAL for the tables it creates.
server_options="-c listen_addresses='' -k '$socket_dir' -c max_connections=5"
server_options+=" -c shared_buffers=32MB -c fsync=off -c synchronous_commit=off"
server_options+=" -c full_page_writes=off -c wal_level=minimal -c max_wal_senders=0"
server_options+=" -c autovacuum=off -c log_min_error_statement=panic -c log_error_verbosity=terse"
server_started=1
if ! run "$run_dir/pg_ctl.log" pg_ctl -D "$server_data" -l "$run_dir/server.log" -w -t 120 \
  -o "$server_options" start; then
  cat "$run_dir/pg_ctl.log" >&2
  if [ -f "$run_dir/server.log" ]; then tail -n 20 "$run_dir/server.log" >&2; fi
  fail 'The scratch server did not start'
fi

scratch=(-X -q -w -v ON_ERROR_STOP=1 -h "$socket_dir" -U postgres)
if ! run "$run_dir/createdb.err" psql "${scratch[@]}" -d postgres \
  -c "CREATE DATABASE \"$database\""; then
  tool_messages psql "$run_dir/createdb.err" --errors
  fail "Could not create $database on the scratch server"
fi

# The restore list: the dump's table of contents without pg_cron. That is the
# extension, its comment, and every entry in schema cron — the job table's rows,
# its run history and their sequences, which the extension would otherwise
# bring back with it.
if ! run "$run_dir/toc.err" pg_restore -l -f "$run_dir/toc.full" "$tmp_dump"; then
  tool_messages pg_restore "$run_dir/toc.err"
  fail "Could not read the dump's table of contents"
fi
cron_re='^[0-9]+; [0-9]+ [0-9]+ (EXTENSION - pg_cron|COMMENT - EXTENSION pg_cron)( |$)|^[0-9]+; [0-9]+ [0-9]+ [A-Z][A-Z ]* cron '
grep -v -E "$cron_re" "$run_dir/toc.full" >"$run_dir/toc.list" || true
left_out=$(grep -c -E "$cron_re" "$run_dir/toc.full" || true)
grep -q -E '^[0-9]+; [0-9]+ [0-9]+ TABLE DATA public sessions ' "$run_dir/toc.list" &&
  grep -q -E '^[0-9]+; [0-9]+ [0-9]+ TABLE DATA public requests ' "$run_dir/toc.list" ||
  fail 'The dump holds no data for public.sessions and public.requests'
log "Restoring into the scratch server, $left_out pg_cron entries left out"

if ! run "$run_dir/restore.err" pg_restore --no-owner --no-acl --single-transaction \
  --exit-on-error -w -L "$run_dir/toc.list" -h "$socket_dir" -U postgres -d "$database" \
  "$tmp_dump"; then
  tool_messages pg_restore "$run_dir/restore.err"
  fail 'The dump did not restore into the scratch server'
fi

counts=$(psql "${scratch[@]}" -A -t -d "$database" \
  -c "SELECT (SELECT count(*) FROM public.sessions) || '|' || (SELECT count(*) FROM public.requests)" \
  2>"$run_dir/count.err") || {
  tool_messages psql "$run_dir/count.err" --errors
  fail 'Could not count the restored rows'
}
restored_sessions=${counts%%|*}
restored_requests=${counts#*|}
[[ $restored_sessions =~ ^[0-9]+$ && $restored_requests =~ ^[0-9]+$ ]] ||
  fail 'Unexpected answer while counting the restored rows'
if [ "$restored_sessions" != "$dump_sessions" ] || [ "$restored_requests" != "$dump_requests" ]; then
  fail "Restore check failed: the dump's snapshot held $dump_sessions sessions and $dump_requests requests, the restored copy $restored_sessions and $restored_requests"
fi
log "Restore check passed: restored $restored_sessions sessions and $restored_requests requests, equal to the dump"

run "$run_dir/pg_ctl.log" pg_ctl -D "$server_data" -m fast -w stop ||
  fail 'The scratch server did not stop'
server_started=0

# 5. Rename and prune ---------------------------------------------------------

if [ -e "$backup_dir/$name" ] || [ -e "$backup_dir/$name.sha256" ]; then
  fail "$name already exists"
fi
# The dump first: interrupted between the two, a run leaves a checked dump
# without its checksum, which the pruning still counts and deletes in time,
# rather than a checksum with no dump, which it would never delete.
mv -- "$tmp_dump" "$backup_dir/$name" || fail "Could not rename the dump to $name"
new_dump=$backup_dir/$name
tmp_dump=
mv -- "$tmp_sum" "$backup_dir/$name.sha256" || fail "Could not rename the checksum to $name.sha256"
new_sum=$backup_dir/$name.sha256
tmp_sum=
(cd "$backup_dir" && sha256sum -c --status "$name.sha256") ||
  fail "$name does not match its checksum"
saved=1
log "Saved $name and $name.sha256"

dump_re="^$database-[0-9]{8}T[0-9]{6}Z[.]dump\$"
dumps=()
for path in "$backup_dir/$database"-*.dump; do
  file=${path##*/}
  if [[ $file =~ $dump_re ]]; then dumps+=("$file"); fi
done
# The glob is sorted, and in the C locale a fixed-width UTC timestamp sorts by
# time, so the oldest come first and the dump just saved last. A dump that
# sorts after it — the clock was set back, or a file was copied in — would push
# the new one out of the newest few, so the run fails instead, deleting nothing.
i=0
while [ "$i" -lt "${#dumps[@]}" ]; do
  if [[ ${dumps[$i]} > $name ]]; then
    fail "${dumps[$i]} sorts after the new dump $name: the clock may have gone back, or the file was copied in. Nothing was deleted."
  fi
  i=$((i + 1))
done
excess=$((${#dumps[@]} - keep))
i=0
while [ "$i" -lt "$excess" ]; do
  old=${dumps[$i]}
  if [ "$old" = "$name" ]; then fail "Refusing to delete the new dump $name"; fi
  rm -f -- "$backup_dir/$old" "$backup_dir/$old.sha256" || fail "Could not delete $old"
  log "Deleted $old and its checksum"
  i=$((i + 1))
done
kept=
while [ "$i" -lt "${#dumps[@]}" ]; do
  kept="$kept ${dumps[$i]}"
  i=$((i + 1))
done
log "Dumps kept:$kept"

# 6. Off-server copy ----------------------------------------------------------

if [ -n "$offsite_dir" ]; then
  [ -d "$offsite_dir" ] && [ -w "$offsite_dir" ] ||
    fail "Off-server copy failed: $offsite_dir is not a writable directory"
  [ -f "$offsite_recipient" ] && [ -r "$offsite_recipient" ] && [ -s "$offsite_recipient" ] ||
    fail 'Off-server copy failed: BACKUP_OFFSITE_RECIPIENT_FILE does not name a readable public key'
  [[ $offsite_wait =~ ^[1-9][0-9]{0,4}$ ]] ||
    fail 'Off-server copy failed: BACKUP_OFFSITE_WAIT_SECONDS must be a whole number from 1'

  # gpg keeps its files in a directory of this run, removed with it; the root
  # filesystem is read-only. --recipient-file reads the key from the file and
  # --trust-model always accepts it, so no keyring and no agent are involved,
  # and --no-autostart keeps gpg from starting one.
  export GNUPGHOME=$run_dir/gnupg
  mkdir -m 700 "$GNUPGHOME" || fail 'Off-server copy failed: could not create a directory for gpg'
  # A temporary name the uploader does not take for a copy.
  offsite_tmp=$offsite_dir/.$name.gpg.tmp
  if ! run "$run_dir/gpg.err" gpg --batch --no-tty --no-autostart --trust-model always \
    --recipient-file "$offsite_recipient" --output "$offsite_tmp" --encrypt "$new_dump"; then
    tool_messages gpg "$run_dir/gpg.err"
    fail "Off-server copy failed: gpg could not encrypt $name"
  fi
  [ -s "$offsite_tmp" ] || fail "Off-server copy failed: gpg wrote no ciphertext for $name"
  copy_bytes=$(wc -c <"$offsite_tmp" | tr -d ' ')
  # Readable by the uploader's uid despite the umask: it is ciphertext.
  chmod 0644 "$offsite_tmp" ||
    fail 'Off-server copy failed: could not make the encrypted copy readable'
  # Both names are known to the cleanup before the rename, so that a stop
  # between the two cannot leave the copy behind.
  offsite_result=$offsite_dir/$name.gpg.result
  offsite_file=$offsite_dir/$name.gpg
  mv -- "$offsite_tmp" "$offsite_file" ||
    fail 'Off-server copy failed: could not hand the encrypted copy to the uploader'
  offsite_tmp=
  log "Encrypted $name as $name.gpg, $copy_bytes bytes; waiting up to $offsite_wait s for the uploader"

  # SECONDS counts whole seconds, so `-gt` waits the full time and up to one
  # second more, never less.
  waited_from=$SECONDS
  until [ -e "$offsite_result" ]; do
    if [ $((SECONDS - waited_from)) -gt "$offsite_wait" ]; then
      fail "Off-server copy failed: the uploader gave no answer within $offsite_wait s"
    fi
    run /dev/null sleep 0.2 || true
  done
  # Another container's file. Only a regular file is read: a FIFO would hold
  # the read, a symbolic link would read whatever it points at.
  if [ -L "$offsite_result" ] || [ ! -f "$offsite_result" ]; then
    fail "Off-server copy failed: the uploader's answer is not a regular file"
  fi
  # The read runs in the background and is given 5 seconds, so that neither a
  # file swapped for a FIFO after the test above nor anything else can hold the
  # run, and a stop signal ends it as it ends any step.
  head -c 2048 -- "$offsite_result" >"$run_dir/answer" 2>/dev/null &
  child_pid=$!
  looks=0
  while kill -0 "$child_pid" 2>/dev/null; do
    if [ "$looks" -ge 50 ]; then
      fail "Off-server copy failed: the uploader's answer could not be read within 5 s"
    fi
    looks=$((looks + 1))
    sleep 0.1
  done
  wait "$child_pid" 2>/dev/null || true
  child_pid=
  # The first two lines, bounded, and of the message only printable ASCII.
  answer=$(tr -d '\000' <"$run_dir/answer") || answer=
  outcome=${answer%%$'\n'*}
  message=
  if [[ $answer == *$'\n'* ]]; then
    message=${answer#*$'\n'}
    message=${message%%$'\n'*}
  fi
  message=${message//[^[:print:]]/ }
  message=${message:0:600}
  case $outcome in
    ok) log "Off-server copy: ${message:-uploaded $name.gpg}" ;;
    fail)
      message=${message:0:240}
      fail "Off-server copy failed: ${message:-the uploader gave no reason}"
      ;;
    *) fail 'Off-server copy failed: the uploader wrote an answer that was not understood' ;;
  esac
fi
log 'Backup succeeded'
