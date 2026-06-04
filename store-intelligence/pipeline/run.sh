#!/bin/bash
# Wrapper script to execute the detection pipeline
# Usage: ./run.sh --clip /path/to/cctv.mp4 [--output events.jsonl]

TARGET=$2

if [ -z "$TARGET" ]; then
  echo "Error: Must provide a clip path or directory."
  echo "Usage: ./run.sh --clip /path/to/video.mp4"
  echo "       ./run.sh --clip /path/to/directory_of_clips"
  exit 1
fi

if [ -d "$TARGET" ]; then
  echo "Found directory. Processing all .mp4 clips in $TARGET..."
  for file in "$TARGET"/*.mp4; do
    if [ -f "$file" ]; then
      echo "--------------------------------------------------------"
      echo "Processing clip: $file"
      python detect.py "$file"
    fi
  done
elif [ -f "$TARGET" ]; then
  echo "Starting detection pipeline for $TARGET"
  python detect.py "$TARGET"
else
  echo "Error: $TARGET is not a valid file or directory."
  exit 1
fi
