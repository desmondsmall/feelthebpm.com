#!/usr/bin/env bash
# Song search, step 2: build the working database open-data.db from the downloaded dumps.
#
#   pipeline/search/load.sh
#
# Unpacks the dumps (about 7 GB uncompressed), runs load.sql on the three CSVs it needs, then deletes them.
# Needs zstd and the sqlite3 command-line tool. Refuses to overwrite an existing open-data.db,
# which takes a long time to rebuild: move it aside first.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "${SEARCH_OPEN_DATA:-$HERE/../cache/open-data}"   # override: the tests use a fixture directory
[ -e open-data.db ] && { echo "open-data.db exists; move it aside to rebuild" >&2; exit 1; }

# Unpack each archive into a scratch directory and pick the CSVs out by name. (Portable: GNU tar
# and macOS's bsdtar disagree on how to select members by pattern.)
X=$(mktemp -d ./extract.XXXXXX)
trap 'rm -rf "$X" ab-rhythm.csv canonical_musicbrainz_data.csv canonical_recording_redirect.csv' EXIT
pick() { local f; f=$(find "$X" -type f -name "$1" | head -1); [ -n "$f" ] || { echo "$1 not found in the dump" >&2; exit 1; }; mv "$f" "$2"; }
zstd -dc ab-rhythm.tar.zst | tar -x -C "$X"
pick '*-rhythm.csv' ab-rhythm.csv
zstd -dc canonical.tar.zst | tar -x -C "$X"
pick canonical_musicbrainz_data.csv canonical_musicbrainz_data.csv
pick canonical_recording_redirect.csv canonical_recording_redirect.csv

sqlite3 open-data.db < "$HERE/load.sql"
sqlite3 open-data.db 'SELECT count(*) || " songs loaded" FROM songs'
