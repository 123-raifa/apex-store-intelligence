# Architecture Design

## Architecture Overview

I built this as a totally offline, edge-compatible system. Instead of pushing raw video streams to the cloud (which takes massive bandwidth), the video is processed locally using a Python pipeline running YOLOv8. It converts heavy bounding box data into lightweight JSON events like "ENTRY" or "ZONE_DWELL". Those events are ingested by a local Node.js/Express server backed by SQLite. Because all compute happens logically inside the store perimeter, the ingestion latency is virtually non-existent, and the app gracefully degrades if the store loses internet connection.

## AI-Assisted Decisions

1. **Detection Pipeline: Cross-Camera Deduplication vs Single-Camera Tracking**
   - *AI Input:* I mentioned my pipeline tracking YOLO IDs natively and the AI suggested I use an embedding extractor (like `OSNet` or `torchreid`) for robust cross-camera Re-ID (Re-Identification) to prevent double counting over cameras.
   - *My Decision:* I vetoed running another heavy embedding model locally. It blows the performance budget on edge compute. I accepted the compromise that cross-camera duplicate tracking relies primarily on local boundary logic rather than expensive facial/clothing similarity embeddings.

2. **Which database to use for event ingestion:**
   - *AI Input:* I prompted the LLM to suggest the best database for high-frequency time-series tracking locally. It strongly recommended setting up TimeScaleDB via PostgreSQL.
   - *My Decision:* I completely overrode this. Running a full Postgres Docker container simultaneously on limited store hardware is an operational nightmare. Instead, I chose SQLite (with WAL mode enabled), trading absolute scalability for zero-configuration, simple file durability perfectly tuned for localized scale.

2. **Handling visitor re-entry (smoke breaks, etc.):**
   - *AI Input:* I asked the AI how to deduplicate tracking IDs for the same person leaving and returning to frame. The AI's solution involved extracting deep visual embeddings via ResNet and storing them in pgvector to run cosine-similarity queries.
   - *My Decision:* I agreed with the necessity of deduplication but strongly rejected the bloated pgvector approach. I heavily downscaled the solution to a simple heuristic radius: if a new entry occurs shortly after an exit, we map the newly generated ID to the recently exited ID in our cache mapping.

3. **Writing the Spatial Intersection logic:**
   - *AI Input:* I used the LLM to write the spatial math checking whether the bounding box's center coordinate intersects with my predefined geometric store zones.
   - *My Decision:* I fully agreed and kept the AI's math completely intact. It efficiently determined overlapping regions without requiring me to spend time recalibrating box collisions manually.
