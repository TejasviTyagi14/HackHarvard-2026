#!/usr/bin/env bash
# Start the detectObject viewer (server + browser). Linux and macOS.
# From Files (right-click > Run as a Program) this runs in its own terminal window, which closes
# when the viewer stops. After an error the window waits for Enter, so the message stays readable.
cd "$(dirname "$0")" || exit 1
.venv/bin/python start_viewer.py "$@"
status=$?
if [ "$status" -ne 0 ] && [ -t 0 ]; then
    read -r -p "The viewer stopped with an error (see above). Press Enter to close this window. " _
fi
exit "$status"
