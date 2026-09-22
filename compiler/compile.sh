#!/bin/sh
set -eu

engine="${1:-pdflatex}"
main="${2:-main.tex}"
case "$engine" in
  pdflatex) mode=-pdf ;;
  xelatex) mode=-xelatex ;;
  lualatex) mode=-lualatex ;;
  *) printf 'Unsupported LaTeX engine: %s\n' "$engine" >&2; exit 2 ;;
esac

if [ "$engine" = lualatex ] && [ -d /var/lib/texmf/luatex-cache ]; then
  mkdir -p "$TEXMFVAR"
  cp -R /var/lib/texmf/luatex-cache "$TEXMFVAR/"
fi

mkdir -p /workspace/build
# TeX's \include writes matching auxiliary subdirectories in the output tree.
find . -type d -exec sh -c 'mkdir -p "/workspace/build/$1"' _ '{}' ';'
# Ignore project .latexmkrc files: they are executable Perl. A fixed job name
# avoids ambiguity when importing projects with spaces or nested main files.
# -g rebuilds from the fresh source snapshot while reusing bibliography/aux data.
exec latexmk -norc "$mode" -g -interaction=nonstopmode -halt-on-error \
  -file-line-error -no-shell-escape -synctex=1 -jobname=typeset \
  -outdir=/workspace/build "./$main"
