#!/usr/bin/env bash
# Verifies the social share meta in a built site. Run after a production build:
#   bundle exec jekyll build --config _config.yml,_config_production.yml
#   scripts/check-social-meta.sh _site
# Exits non-zero on the first page whose card would render without a large preview.
set -euo pipefail

SITE_DIR="${1:-_site}"
HANDLE="@code_w1th_me"
failures=0

meta() { # meta <file> <attr-name> -> content of the first matching meta tag
    grep -oE "<meta (name|property)=\"$2\" content=\"[^\"]*\"" "$1" | head -1 | sed -E 's/.*content="([^"]*)"/\1/' || true
}

fail() { echo "FAIL $1: $2"; failures=$((failures + 1)); }

check_page() { # check_page <path-in-site> <expected-image-substring>
    local file="$SITE_DIR/$1"
    [[ -f "$file" ]] || { fail "$1" "page not built"; return; }

    local card site creator image
    card=$(meta "$file" "twitter:card")
    site=$(meta "$file" "twitter:site")
    image=$(meta "$file" "og:image")

    [[ "$card" == "summary_large_image" ]] || fail "$1" "twitter:card is '$card'"
    [[ "$site" == "$HANDLE" ]] || fail "$1" "twitter:site is '$site'"
    [[ "$image" == *"$2"* ]] || { fail "$1" "og:image is '$image', expected *$2*"; return; }

    local image_path="${image#https://codewithkyryl.dev}"
    [[ -f "$SITE_DIR/${image_path#/}" ]] || fail "$1" "og:image file $image_path missing from build"
}

check_creator() { # check_creator <path-in-site>
    local creator
    creator=$(meta "$SITE_DIR/$1" "twitter:creator")
    [[ "$creator" == "$HANDLE" ]] || fail "$1" "twitter:creator is '$creator'"
}

# Every article gets its own generated image.
while IFS= read -r article; do
    slug=$(basename "$article" .md)
    page=$(grep -rl --include=index.html "og/articles/$slug.png" "$SITE_DIR" | head -1 || true)
    if [[ -z "$page" ]]; then fail "_articles/$slug.md" "no built page references og/articles/$slug.png"; continue; fi
    check_page "${page#$SITE_DIR/}" "/assets/og/articles/$slug.png"
    check_creator "${page#$SITE_DIR/}"
done < <(ls _articles/*.md)

# Non-article pages fall back to the branded default image.
for page in index.html practice/index.html quizzes/index.html quizzes/kafka-senior/index.html labs/kafka-local-cache/index.html; do
    check_page "$page" "/assets/img/og-default.png"
done

if (( failures > 0 )); then
    echo "$failures social meta check(s) failed"
    exit 1
fi
echo "social meta OK"
