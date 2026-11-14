#!/bin/sh
# Prompts for the ElevenLabs API key without echoing it, and stores it in
# .dev.vars (gitignored). Nothing is printed, logged or sent anywhere.
cd "$(dirname "$0")/.." || exit 1
printf 'Paste your ElevenLabs API key (input is hidden), then press Enter: '
stty -echo 2>/dev/null
IFS= read -r KEY
stty echo 2>/dev/null
printf '\n'
KEY=$(printf '%s' "$KEY" | tr -d '[:space:]')
if [ -z "$KEY" ]; then
  echo 'No key entered. Nothing was saved.'
  exit 1
fi
touch .dev.vars
grep -v '^ELEVENLABS_API_KEY=' .dev.vars > .dev.vars.tmp 2>/dev/null
printf 'ELEVENLABS_API_KEY=%s\n' "$KEY" >> .dev.vars.tmp
mv .dev.vars.tmp .dev.vars
chmod 600 .dev.vars
echo 'Saved to .dev.vars (gitignored). You can close this tab.'
