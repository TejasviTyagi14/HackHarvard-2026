#!/usr/bin/env bash
# Start the detectObject viewer (server + browser). Linux and macOS.
cd "$(dirname "$0")" && exec .venv/bin/python start_viewer.py "$@"
