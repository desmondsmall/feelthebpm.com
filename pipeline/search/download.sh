#!/usr/bin/env bash
# Song search, step 1: download the two open-data dumps and check them against their published
# SHA-256 sums. Both are CC0, from MetaBrainz (https://data.metabrainz.org/).
#
#   pipeline/search/download.sh [musicbrainz-canonical-dump-YYYYMMDD-HHMMSS]
#
# - AcousticBrainz low-level rhythm features (1.26 GB): one tempo reading per submission. The
#   project shut down in 2022, so this final dump never changes.
# - MusicBrainz canonical data (~2.4 GB): artist credit and title per recording, and the redirects
#   that merge many recordings into one song. Republished on the 1st and 15th of each month; the
#   newest is used unless one is named. Its name is recorded in canonical.version for the manifest.
# Downloads resume if interrupted, and a file whose checksum already matches isn't fetched again.
set -euo pipefail
cd "$(dirname "$0")/../cache" && mkdir -p open-data && cd open-data

AB=https://data.metabrainz.org/pub/musicbrainz/acousticbrainz/dumps/acousticbrainz-lowlevel-features-20220623
CANON=https://data.metabrainz.org/pub/musicbrainz/canonical_data
sha() { shasum -a 256 "$1" | cut -c1-64; }

fetch() {   # fetch <url> <local file> <expected sha256>
  if [ -f "$2" ] && [ "$(sha "$2")" = "$3" ]; then echo "$2: already downloaded, checksum OK"; return; fi
  echo "$2: downloading $1"
  curl -fL --retry 5 -C - -o "$2" "$1"
  [ "$(sha "$2")" = "$3" ] || { echo "$2: checksum mismatch" >&2; exit 1; }
  echo "$2: checksum OK"
}

ab_sum=$(curl -fsS "$AB/sha256sums" | awk '/-rhythm\.tar\.zst$/ {print $1}')
fetch "$AB/acousticbrainz-lowlevel-features-20220623-rhythm.tar.zst" ab-rhythm.tar.zst "$ab_sum"

dump=${1:-$(curl -fsS "$CANON/" | grep -oE 'musicbrainz-canonical-dump-[0-9]{8}-[0-9]{6}' | sort -u | tail -1)}
canon_sum=$(curl -fsS "$CANON/$dump/$dump.tar.zst.sha256" | cut -c1-64)
fetch "$CANON/$dump/$dump.tar.zst" canonical.tar.zst "$canon_sum"
echo "$dump" > canonical.version
echo "done: $dump"
