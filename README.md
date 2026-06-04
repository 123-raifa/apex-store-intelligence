# Apex Retail: Store Intelligence System

End-to-End Store Intelligence Pipeline.

## 1. Quick Start (Running via Docker)

You can launch the entire API and Dashboard infrastructure using Docker Compose. This ensures zero manual setup beyond cloning the repository.

```bash
# 1. Clone the repository
git clone <your-repo>
cd <root-folder>

# 2. Create the local SQLite database file (required for Docker mounting)
# Note: On Windows PowerShell, use "New-Item data.sqlite -ItemType File"
touch data.sqlite

# 3. Start the application
docker compose up -d --build
```

The API and Web Dashboard will now be available at `http://localhost:3000`.

## 2. Web Dashboard (Part E)

**Local Dashboard URL:** [http://localhost:3000](http://localhost:3000)

Visit `http://localhost:3000` in your browser to view the real-time reactivity metric UI, check out the store conversion funnel, heatmap information, and anomaly alerts.

## 3. Detection Pipeline

The detection pipeline processes video clips and produces events that are sent to the local API. It will also capture all generated events and append them sequentially to an `events.jsonl` file locally.

**Requirements:** Python 3.9+

To run the offline generation layer natively on your machine:

```bash
cd store-intelligence/pipeline
pip install -r requirements.txt

# Option A: Run a single clip directly using Python
python detect.py "C:\Path\To\CAM_1.mp4"

# Option B: Run the wrapper script for a directory 
bash run.sh --clip "C:\Path\To\directory_of_clips"
```

> **Note for Windows Users:**
> On Windows PowerShell, `./run.sh` will not natively execute correctly as a bash script. Please use Git Bash to run `bash run.sh`, or alternatively, skip the script and simply run `python detect.py "C:\Path\To\Video.mp4"` directly in your PowerShell terminal to trigger event generation.

## 4. API Endpoints

- `POST /events/ingest` - Receives pipeline events (Returns 200 without 5xx errors).
- `GET /stores/{id}/metrics` - Live store metrics. (e.g. Try `GET /stores/STORE_BLR_002/metrics` to receive a valid JSON response).
- `GET /stores/{id}/funnel` - Live conversion funnel.
- `GET /stores/{id}/heatmap` - Zone interaction and dwell times.
- `GET /stores/{id}/anomalies` - Alerts for queue depth, checkout rate drops.
- `GET /health` - System health and stale feed detection.
