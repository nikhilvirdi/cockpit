#!/bin/sh
set -eu
case "$1" in
    python) exec /opt/python/bin/python -I -B /opt/cockpit/python.py "$2" ;;
    go) exec /opt/cockpit/go-analyze "$2" ;;
    java) exec java -XX:MaxRAMPercentage=65 -cp '/opt/cockpit:/opt/cockpit/jars/*' Analyze "$2" ;;
    c|cpp) exec /opt/cockpit/clang-analyze "$2" ;;
    *) exit 64 ;;
esac
