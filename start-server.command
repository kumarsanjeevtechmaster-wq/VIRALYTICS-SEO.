#!/bin/bash
# Viralytics — double-click launcher (macOS / Linux)
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  ✗  Node.js nahi mila."
  echo ""
  echo "  Pehle Node.js install karo (free):  https://nodejs.org"
  echo "  Download Node.js (LTS) → installer mein Next/Install chalaao."
  echo "  Phir ye file dobara double-click karo."
  echo ""
  read -p "  Enter dabao band karne ke liye..."
  exit 1
fi

echo ""
echo "  Viralytics dashboard chalu ho raha hai..."
echo "  Browser khud khulega (http://localhost:8420)."
echo "  Band karne ke liye: bas ye terminal window band kar do."
echo ""
open "http://localhost:8420" 2>/dev/null || xdg-open "http://localhost:8420" 2>/dev/null
node tools/go.js
