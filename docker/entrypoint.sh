#!/bin/sh
# Container entrypoint.
#
# As root: map a `hearer` user/group to PUID/PGID, fix ownership of /data and
# /staging, apply UMASK and drop privileges with su-exec.
# As non-root (docker run --user): skip user management, apply UMASK and exec.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
UMASK="${UMASK:-002}"
DATA_DIR="${DATA_DIR:-/data}"
MUSIC_DIR="${MUSIC_DIR:-/music}"
STAGING_DIR="${STAGING_DIR:-/staging}"

log() { printf 'entrypoint: %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

is_number() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

is_umask() {
  case "$1" in
    '' | *[!0-7]*) return 1 ;;
  esac
  [ "${#1}" -ge 3 ] && [ "${#1}" -le 4 ]
}

is_umask "$UMASK" || die "UMASK must be 3 or 4 octal digits (got '$UMASK')"

if [ "$(id -u)" -ne 0 ]; then
  umask "$UMASK"
  exec "$@"
fi

is_number "$PUID" || die "PUID must be a number (got '$PUID')"
is_number "$PGID" || die "PGID must be a number (got '$PGID')"

# Running the app as root is allowed but discouraged.
if [ "$PUID" -eq 0 ]; then
  log "warning: PUID=0, running as root"
  umask "$UMASK"
  exec "$@"
fi
[ "$PGID" -ne 0 ] || die "PGID=0 with a non-root PUID is not supported"

# Name of the user/group currently holding an id, if any.
name_for_uid() { awk -F: -v id="$1" '$3 == id { print $1; exit }' /etc/passwd; }
name_for_gid() { awk -F: -v id="$1" '$3 == id { print $1; exit }' /etc/group; }
have_user() { awk -F: -v n="$1" '$1 == n { f = 1 } END { exit !f }' /etc/passwd; }
have_group() { awk -F: -v n="$1" '$1 == n { f = 1 } END { exit !f }' /etc/group; }

# Is `hearer` already exactly right (container restart)?
current_uid="$(awk -F: '$1 == "hearer" { print $3; exit }' /etc/passwd)"
current_gid="$(awk -F: '$1 == "hearer" { print $4; exit }' /etc/passwd)"

if [ "$current_uid" != "$PUID" ] || [ "$current_gid" != "$PGID" ]; then
  have_user hearer && deluser hearer >/dev/null 2>&1
  have_group hearer && delgroup hearer >/dev/null 2>&1

  # Free the ids if another account (such as the image's built-in `node`
  # user, uid/gid 1000) holds them.
  other_user="$(name_for_uid "$PUID")"
  if [ -n "$other_user" ]; then
    log "removing user '$other_user' that holds uid $PUID"
    deluser "$other_user" >/dev/null 2>&1 || die "cannot remove user '$other_user'"
  fi
  other_group="$(name_for_gid "$PGID")"
  if [ -n "$other_group" ]; then
    log "removing group '$other_group' that holds gid $PGID"
    delgroup "$other_group" >/dev/null 2>&1 || die "cannot remove group '$other_group'"
  fi

  addgroup -g "$PGID" hearer || die "cannot create group hearer ($PGID)"
  adduser -D -H -s /sbin/nologin -G hearer -u "$PUID" hearer \
    || die "cannot create user hearer ($PUID)"
fi

for dir in "$DATA_DIR" "$STAGING_DIR"; do
  mkdir -p "$dir"
  chown -R "$PUID:$PGID" "$dir" || die "cannot chown $dir"
done

# The library is never chowned: it is usually a shared mount. Only warn.
if [ -d "$MUSIC_DIR" ]; then
  su-exec "$PUID:$PGID" test -w "$MUSIC_DIR" \
    || log "warning: $MUSIC_DIR is not writable by uid $PUID / gid $PGID; uploads cannot be imported until it is"
else
  log "warning: $MUSIC_DIR does not exist"
fi

umask "$UMASK"
exec su-exec "$PUID:$PGID" "$@"
