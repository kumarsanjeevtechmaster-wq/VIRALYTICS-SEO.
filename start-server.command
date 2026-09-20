#!/bin/bash
# Viralytics SEO Command Center — Mac/Linux ke liye.
# Is file par double-click karo (ya Terminal mein: bash start-server.command).
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  ✗ Node.js nahi mila."
  echo ""
  echo "  Pehle https://nodejs.org se Node.js LTS install karo,"
  echo "  phir ye wahi file dobara double-click karo. Bas."
  echo ""
  read -p "  Enter dabao..."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1 && ! command -v python >/dev/null 2>&1; then
  echo "  Note: Python nahi mila — report banane ke liye Python chahiye"
  echo "  (https://www.python.org/downloads/). Bas dashboard abhi bhi chalega."
  echo ""
fi

echo "  Viralytics dashboard chalu ho raha hai..."
echo "  Browser khud khulega (http://localhost:8420)."
echo "  Band karne ke liye: bas ye window band karo (ya Ctrl+C)."
echo ""
( sleep 2 && open http://localhost:8420 ) >/dev/null 2>&1 || true
node tools/go.js
