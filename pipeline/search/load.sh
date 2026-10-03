#!/usr/bin/env bash
# Song search, step 2: build the working database open-data.db from the downloaded dumps.
#
#   pipeline/search/load.sh
#
# Extracts the three CSVs load.sql imports (about 6 GB uncompressed), runs it, then deletes them.
# Needs zstd and the sqlite3 command-line tool. Refuses to overwrite an existing open-data.db,
# which takes a long time to rebuild: move it aside first.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
cd "${SEARCH_OPEN_DATA:-$HERE/../cache/open-data}"   # override: the tests use a fixture directory
[ -e open-data.db ] && { echo "open-data.db exists; move it aside to rebuild" >&2; exit 1; }

# Extract by name: a bare `tar -xO` would also append each dump's COPYING file to the CSV.
zstd -dc ab-rhythm.tar.zst | tar -xO --include='*-rhythm.csv' > ab-rhythm.csv
zstd -dc canonical.tar.zst | tar -xO --include='*/canonical_musicbrainz_data.csv' > canonical_musicbrainz_data.csv
zstd -dc canonical.tar.zst | tar -xO --include='*/canonical_recording_redirect.csv' > canonical_recording_redirect.csv
trap 'rm -f ab-rhythm.csv canonical_musicbrainz_data.csv canonical_recording_redirect.csv' EXIT

sqlite3 open-data.db < "$HERE/load.sql"
sqlite3 open-data.db 'SELECT count(*) || " songs loaded" FROM songs'
