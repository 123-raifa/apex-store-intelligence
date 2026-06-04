import cv2
import json
import time
import uuid
import requests
from ultralytics import YOLO
from datetime import datetime, timezone, timedelta

# Configuration
API_INGEST_URL = "http://localhost:3000/events/ingest"
STORE_ID = "ST1076" 
CAMERA_ID = "CAM_MAIN_01"

# Define mock zones (Ideally load this from your store_layout.json)
import os

def load_zones():
    layout_path = "store_layout.json"
    if os.path.exists(layout_path):
        try:
            with open(layout_path, "r") as f:
                data = json.load(f)
                print(f"✅ Loaded zones dynamically from {layout_path}")
                # Adapt based on the actual JSON structure you have
                return data.get("zones", data) 
        except Exception as e:
            print(f"⚠️ Error reading {layout_path}: {e}")
            
    print("⚠️ 'store_layout.json' not found locally. Using default Purplle store fallback zones.")
    return {
        "SKINCARE": {"x1": 50, "y1": 50, "x2": 450, "y2": 450},
        "MAKEUP": {"x1": 500, "y1": 50, "x2": 950, "y2": 450},
        "LIPSTICK_AISLE": {"x1": 50, "y1": 500, "x2": 450, "y2": 950},
        "BILLING": {"x1": 1000, "y1": 50, "x2": 1800, "y2": 600}
    }

ZONES = load_zones()

def is_in_zone(x, y, zone_coords):
    return (zone_coords["x1"] < x < zone_coords["x2"]) and (zone_coords["y1"] < y < zone_coords["y2"])

def run_detection(video_path):
    print(f"Loading YOLOv8 model for {video_path}...")
    # Using the standard YOLOv8 nano model (downloads automatically)
    model = YOLO('yolov8n.pt') 
    
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print("Error: Could not open video.")
        return

    # Track active users in zones to detect DWELL and ZONE_EXIT
    active_tracks = {}

    fps = cap.get(cv2.CAP_PROP_FPS)
    if not fps or fps <= 0:
        fps = 30.0
    video_start_time = datetime.now(timezone.utc)
    
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    virtual_line_y = int(height * 0.5) if height > 0 else 300
    print(f"📏 Video resolution height: {height}, setting line-crossing threshold: {virtual_line_y}")

    print("Starting frame processing...")
    frame_count = 0

    while cap.isOpened():
        success, frame = cap.read()
        if not success:
            break
            
        frame_count += 1
        
        # Skip frames to speed up processing on CPU (process every 2nd frame)
        if frame_count % 2 != 0:
            continue
        
        # Run YOLOv8 tracking (persists IDs across frames automatically)
        # Using imgsz=320 for drastically faster CPU inference
        results = model.track(frame, persist=True, classes=[0], verbose=False, imgsz=320)
        
        events_batch = []
        offset_seconds = frame_count / fps
        current_dt = video_start_time + timedelta(seconds=offset_seconds)
        current_time = current_dt.isoformat()

        if results[0].boxes.id is not None:
            boxes = results[0].boxes.xyxy.cpu().numpy()
            track_ids = results[0].boxes.id.cpu().numpy()
            confidences = results[0].boxes.conf.cpu().numpy()

            for box, track_id, conf in zip(boxes, track_ids, confidences):
                x1, y1, x2, y2 = box
                cx, cy = (x1 + x2) / 2, (y1 + y2) / 2 # Center point
                str_track_id = f"VIS_{int(track_id)}"

                # Check which zone the person is currently in
                current_zone = None
                for zone_name, coords in ZONES.items():
                    if is_in_zone(cx, cy, coords):
                        current_zone = zone_name
                        break

                # Staff Detection Heuristic (Color check for uniform - e.g., Purple/Blue tone)
                current_image_patch = frame[int(y1):int(y2), int(x1):int(x2)]
                
                is_staff = False
                if current_image_patch.size > 0:
                    hsv = cv2.cvtColor(current_image_patch, cv2.COLOR_BGR2HSV)
                    # Check for purple/dark blue uniform (Hue 120-160, somewhat saturated)
                    mask = cv2.inRange(hsv, (110, 50, 50), (160, 255, 255))
                    ratio = cv2.countNonZero(mask) / (mask.shape[0] * mask.shape[1])
                    if ratio > 0.15:
                        is_staff = True

                if str_track_id not in active_tracks:
                    # New track initialized
                    active_tracks[str_track_id] = {
                        "first_seen": time.time(),
                        "last_seen_frame": frame_count,
                        "session_seq": 1,
                        "last_y": cy,
                        "zone": None,
                        "zone_entry_time": None,
                        "is_staff": is_staff,
                        "emitted_entry": False,
                        "emitted_exit": False
                    }
                    
                    # If they are already in the interior area (cy > virtual_line_y) when first seen,
                    # we assume they entered. Otherwise we wait until they cross.
                    if cy > virtual_line_y:
                        active_tracks[str_track_id]["emitted_entry"] = True
                        events_batch.append({
                            "event_id": str(uuid.uuid4()),
                            "store_id": STORE_ID,
                            "camera_id": CAMERA_ID,
                            "visitor_id": str_track_id,
                            "event_type": "ENTRY",
                            "timestamp": current_time,
                            "confidence": float(conf),
                            "is_staff": is_staff,
                            "metadata": {"session_seq": 1}
                        })
                        active_tracks[str_track_id]["session_seq"] += 1
                else:
                    # Refresh is_staff if confidently detected later
                    if is_staff and not active_tracks[str_track_id]["is_staff"]:
                        active_tracks[str_track_id]["is_staff"] = True

                    track_state = active_tracks[str_track_id]
                    last_y = track_state.get("last_y", cy)
                    track_state["last_seen_frame"] = frame_count
                    track_state["last_y"] = cy
                    
                    # Track crossing with direction vector
                    # Inbound: crossing downward (increasing y towards interior of the store)
                    if last_y <= virtual_line_y < cy and not track_state["emitted_entry"]:
                        track_state["emitted_entry"] = True
                        events_batch.append({
                            "event_id": str(uuid.uuid4()),
                            "store_id": STORE_ID,
                            "camera_id": CAMERA_ID,
                            "visitor_id": str_track_id,
                            "event_type": "ENTRY",
                            "timestamp": current_time,
                            "confidence": float(conf),
                            "is_staff": track_state["is_staff"],
                            "metadata": {"session_seq": track_state["session_seq"]}
                        })
                        track_state["session_seq"] += 1
                    
                    # Outbound: crossing upward (decreasing y towards street/exit door)
                    elif cy <= virtual_line_y < last_y and not track_state["emitted_exit"]:
                        track_state["emitted_exit"] = True
                        events_batch.append({
                            "event_id": str(uuid.uuid4()),
                            "store_id": STORE_ID,
                            "camera_id": CAMERA_ID,
                            "visitor_id": str_track_id,
                            "event_type": "EXIT",
                            "timestamp": current_time,
                            "confidence": float(conf),
                            "is_staff": track_state["is_staff"],
                            "metadata": {"session_seq": track_state["session_seq"]}
                        })
                        track_state["session_seq"] += 1

                # Handle Zone Transitions
                if current_zone != track_state["zone"]:
                    if track_state["zone"] is not None:
                        # Left previous zone
                        events_batch.append({
                            "event_id": str(uuid.uuid4()),
                            "store_id": STORE_ID,
                            "visitor_id": str_track_id,
                            "event_type": "ZONE_EXIT",
                            "camera_id": CAMERA_ID,
                            "zone_id": track_state["zone"],
                            "timestamp": current_time,
                            "confidence": float(conf),
                            "is_staff": track_state["is_staff"],
                            "metadata": {"session_seq": track_state["session_seq"]}
                        })
                        track_state["session_seq"] += 1
                    
                    if current_zone is not None:
                        # Entered new zone
                        track_state["zone_entry_time"] = time.time()
                        
                        event_metadata = {"session_seq": track_state["session_seq"]}
                        if current_zone == "BILLING":
                            # Calculate dynamic queue depth (all active users currently in BILLING)
                            current_billing_count = sum(1 for t in active_tracks.values() if t.get("zone") == "BILLING" and not t.get("is_staff"))
                            event_metadata["queue_depth"] = current_billing_count + 1
                        elif current_zone is not None:
                            event_metadata["sku_zone"] = current_zone
                            
                        events_batch.append({
                            "event_id": str(uuid.uuid4()),
                            "store_id": STORE_ID,
                            "camera_id": CAMERA_ID,
                            "visitor_id": str_track_id,
                            "event_type": "BILLING_QUEUE_JOIN" if current_zone == "BILLING" else "ZONE_ENTER",
                            "zone_id": current_zone,
                            "timestamp": current_time,
                            "confidence": float(conf),
                            "is_staff": track_state["is_staff"],
                            "metadata": event_metadata
                        })
                        track_state["session_seq"] += 1

                        # Note: BILLING_QUEUE_JOIN serves as both ZONE_ENTER and the specialized JOIN event.

                    track_state["zone"] = current_zone

                # Handle continuous Dwell Emission (Emit every 30 seconds)
                if track_state["zone"] is not None:
                    dwell_time = time.time() - track_state["zone_entry_time"]
                    if dwell_time > 30 and track_state.get("last_dwell_emit", 0) < time.time() - 30:
                        events_batch.append({
                            "event_id": str(uuid.uuid4()),
                            "store_id": STORE_ID,
                            "camera_id": CAMERA_ID,
                            "visitor_id": str_track_id,
                            "event_type": "ZONE_DWELL",
                            "zone_id": track_state["zone"],
                            "timestamp": current_time,
                            "dwell_ms": int(dwell_time * 1000),
                            "confidence": float(conf),
                            "is_staff": track_state["is_staff"],
                            "metadata": {"session_seq": track_state["session_seq"]}
                        })
                        track_state["session_seq"] += 1
                        track_state["last_dwell_emit"] = time.time()

        # Check for EXITS (no detections for 30 frames)
        exited_tracks = []
        for track_id, track_state in active_tracks.items():
            if frame_count - track_state.get("last_seen_frame", frame_count) > 30:
                if track_state["zone"] == "BILLING":
                    events_batch.append({
                        "event_id": str(uuid.uuid4()),
                        "store_id": STORE_ID,
                        "camera_id": CAMERA_ID,
                        "visitor_id": track_id,
                        "event_type": "BILLING_QUEUE_ABANDON",
                        "timestamp": current_time,
                        "confidence": 0.95,
                        "is_staff": track_state.get("is_staff", False),
                        "metadata": {"queue_depth": max(0, sum(1 for t in active_tracks.values() if t.get("zone") == "BILLING" and not t.get("is_staff")) - 1), "session_seq": track_state["session_seq"]}
                    })
                    track_state["session_seq"] += 1
                elif track_state["zone"] is not None:
                    events_batch.append({
                        "event_id": str(uuid.uuid4()),
                        "store_id": STORE_ID,
                        "camera_id": CAMERA_ID,
                        "visitor_id": track_id,
                        "event_type": "ZONE_EXIT",
                        "zone_id": track_state["zone"],
                        "timestamp": current_time,
                        "confidence": 0.95,
                        "is_staff": track_state.get("is_staff", False),
                        "metadata": {"session_seq": track_state["session_seq"]}
                    })
                    track_state["session_seq"] += 1
                if not track_state.get("emitted_exit", False):
                    events_batch.append({
                        "event_id": str(uuid.uuid4()),
                        "store_id": STORE_ID,
                        "camera_id": CAMERA_ID,
                        "visitor_id": track_id,
                        "event_type": "EXIT",
                        "timestamp": current_time,
                        "confidence": 0.95,
                        "is_staff": track_state.get("is_staff", False),
                        "metadata": {"session_seq": track_state["session_seq"]}
                    })
                    track_state["session_seq"] += 1
                exited_tracks.append(track_id)
        
        for track_id in exited_tracks:
            del active_tracks[track_id]

        # Emit batch to API
        if len(events_batch) > 0:
            try:
                # Fire and forget emission to local ingest API
                requests.post(API_INGEST_URL, json=events_batch, timeout=2)
                # print(f"Emitted {len(events_batch)} events.")
            except Exception as e:
                print(f"Failed to ingest (is the server running?): {e}")

            # Also log to events.jsonl
            with open("events.jsonl", "a") as f:
                for ev in events_batch:
                    f.write(json.dumps(ev) + "\n")


        # Optional: Render frame for visualization 
        # (Comment out if running headless server)
        res_plotted = results[0].plot()
        cv2.imshow("Store Tracking", res_plotted)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

    cap.release()
    cv2.destroyAllWindows()
    print("Video processing complete.")

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python detect.py /path/to/cctv_video.mp4")
    else:
        video = sys.argv[1]
        run_detection(video)
