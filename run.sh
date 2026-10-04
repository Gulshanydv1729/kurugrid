#!/usr/bin/env bash
# KuruGrid — run script

set -euo pipefail

# Use the slow-network install flags if needed (see AGENTS.md §9)
INSTALL_FLAGS="--no-audit --no-fund --maxsockets=2 --fetch-timeout=1800000 --fetch-retries=8 --fetch-retry-mintimeout=20000"

echo "📦 Installing dependencies..."
npm install $INSTALL_FLAGS

echo "🔨 Building for production (static export)..."
npm run build

echo "🚀 Starting dev server at http://localhost:3000 ..."
npm run dev