# Design Choices

## 1. Detection Model Selection
- **Options Considered:** YOLO11, Grounding DINO, YOLOv8.
- **AI Suggestion:** The LLM recommended YOLO11 for cutting-edge accuracy, or Grounding DINO for highly versatile text-prompted detection.
- **What I chose and why:** I chose YOLOv8. Although YOLO11 is newer, YOLOv8 currently dominates when it comes to out-of-the-box tracking library support (like ByteTrack and DeepSORT natively integrating with Ultralytics). Grounding DINO was instantly vetoed because it's massively too slow to reliably process real-time feeds on CPU-only local edge devices.

## 2. Event Schema Design Rationale
- **Options Considered:** Full state-polling stream vs. Discrete checkpoint events.
- **AI Suggestion:** Initially, the LLM suggested a heavily normalized time-series implementation, pushing database updates tracking XY coordinates for every individual, 30 times a second.
- **What I chose and why:** I intentionally overrode this entirely for Discrete checkpoint events. Pushing coordinate matrices every frame explodes the local SQLite disk allocation by gigabytes unnecessarily. I scaled the pipeline to only trigger analytical checkpoints (like `ZONE_ENTER` and `ZONE_DWELL`). This accurately solves edge cases (funnels, queues) without choking disk write speeds.

## 3. API Architecture Decisions (Storage Engine)
- **Options Considered:** Redis, PostgreSQL, SQLite.
- **AI Suggestion:** The AI recommended PostgreSQL hooked to a Timescale extension.
- **What I chose and why:** I chose `better-sqlite3`. Because these servers are operating out in retail stores instead of a clean, monitored cloud environment, any additional service layers (like requiring a Postgres Docker daemon or managing a Redis crash loop instance) represents a critical vulnerability. Keeping data localized into a highly transportable `data.sqlite` artifact secures maximum operability without demanding dedicated IT monitoring.

## 4. Vision Language Models (VLM) vs Rule-Based Heuristics
- **Options Considered:** GPT-4V/Claude Vision for Zone/Staff detection vs Rule-Based checking (HSV checks + bounding boxes).
- **AI Suggestion:** The AI recommended passing cropped images to a VLM for highly accurate, zero-shot staff uniform identification and zone activity context.
- **What I chose and why:** I deliberately rejected VLMs in favor of rule-based HSV heuristics. Pinging an external VLM API for bounding box crops is impossible here for two reasons: (1) Cost – analyzing crops frame-by-frame across dozens of customers explodes API budgets quickly, and (2) Latency – network trips to an LLM break the real-time processing constraints for an edge device. A simple HSV color check for the staff uniform runs in less than 1 millisecond locally.
