import os
import re
import sys
import json
import time
import pickle
import traceback
import threading
import asyncio
import uuid
from uuid import uuid4
from pathlib import Path
from typing import List, Optional
from collections import defaultdict, OrderedDict
import logging
from logging.handlers import RotatingFileHandler
from glob import glob

import numpy as np
from PIL import Image, UnidentifiedImageError
from deepface import DeepFace
import faiss
import hdbscan

from fastapi import FastAPI, UploadFile, File, Form, WebSocket, WebSocketDisconnect
from fastapi.websockets import WebSocketState
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# -------------------------------------------------------------
# PATH SETUP
# -------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent
UPLOADS_DIR = BASE_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Face Project API", version="4.0")
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

# -------------------------------------------------------------
# CORS
# -------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# -------------------------------------------------------------
# GLOBAL WEBSOCKET PROGRESS SESSIONS
# -------------------------------------------------------------
progress_sessions = {}

# -------------------------------------------------------------
# HELPERS
# -------------------------------------------------------------
def safe_filename(name: str, default_ext: str = ".jpg") -> str:
    base = os.path.basename(name or "")
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", base)
    if not cleaned:
        cleaned = f"file_{uuid4().hex[:8]}{default_ext}"
    if "." not in cleaned:
        cleaned += default_ext
    return cleaned


def compress_image_file(src_path: Path, quality: int = 70, max_size=(1280, 1280)) -> bool:
    try:
        with Image.open(src_path) as img:
            img = img.convert("RGB")
            img.thumbnail(max_size, Image.LANCZOS)
            temp = src_path.with_suffix(".compressed.jpg")
            img.save(temp, "JPEG", quality=quality, optimize=True)
        temp.replace(src_path)
        print(f"[compress] ✅ {src_path.name}")
        return True
    except Exception as e:
        print(f"[compress] ⚠️ {src_path}: {e}")
        return False


def compress_all_images(folder: Path):
    count = 0
    for img in folder.rglob("*.[jp][pn]g"):
        if any(x in str(img).lower() for x in ["faces", "embedding", "logs", "tmp_search"]):
            continue
        if compress_image_file(img):
            count += 1
    print(f"[compress] ✅ Compressed {count} images in {folder.name}")


def to_relative(p: str):
    if not p:
        return p
    p = p.replace("\\", "/")
    i = p.lower().find("/uploads/")
    return p[i:] if i >= 0 else p


# -------------------------------------------------------------
# LOGGING
# -------------------------------------------------------------
def setup_logging(log_dir: str):
    os.makedirs(log_dir, exist_ok=True)
    logfile = os.path.join(log_dir, "process_faces.log")

    logger = logging.getLogger(f"face_processor_{uuid4().hex[:6]}")
    if logger.hasHandlers():
        logger.handlers.clear()
    logger.setLevel(logging.DEBUG)

    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    ch.setFormatter(logging.Formatter("%(asctime)s | %(message)s", datefmt="%H:%M:%S"))

    fh = RotatingFileHandler(logfile, maxBytes=5_000_000, backupCount=3)
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter("%(asctime)s | %(levelname)-7s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))

    logger.addHandler(ch)
    logger.addHandler(fh)
    return logger, logfile


# -------------------------------------------------------------
# HDBSCAN PARAMS
# -------------------------------------------------------------
def choose_hdbscan_params(n):
    if n < 100:
        return dict(min_cluster_size=3, min_samples=1)
    if n < 500:
        return dict(min_cluster_size=5, min_samples=3)
    if n < 2000:
        return dict(min_cluster_size=8, min_samples=5)
    return dict(min_cluster_size=max(15, int(0.01 * n)), min_samples=max(5, int(0.005 * n)))


# -------------------------------------------------------------
# PROCESS FACES (with websocket progress)
# -------------------------------------------------------------
async def process_faces(
    dataset_dir: str,
    output_dir: str,
    event_id: str,
    model_name="Facenet512",
    detector_backend="retinaface",
):
    log_dir = os.path.join(output_dir, "logs")
    logger, logfile = setup_logging(log_dir)
    start = time.time()

    logger.info("Starting face processing for: %s", dataset_dir)

    # -----------------------------------------------------
    # LOAD IMAGES (remove duplicates)
    # -----------------------------------------------------
    imgs = []
    for pat in ["*.jpg", "*.jpeg", "*.png", "*.JPG", "*.PNG"]:
        imgs.extend(glob(os.path.join(dataset_dir, "**", pat), recursive=True))

    # 🛑 FIX 1: Remove duplicated file paths from glob
    imgs = list(dict.fromkeys(imgs))

    # Filter trash
    imgs = [p for p in imgs if not any(x in p.lower() for x in ["cover", "logs", "thumb"])]
    imgs = sorted(imgs)

    total = len(imgs)
    if total == 0:
        raise ValueError("No images found.")

    logger.info("Found %d unique images", total)

    embeds, meta = [], []

    # -----------------------------------------------------
    # WebSocket progress helper
    # -----------------------------------------------------
    async def send_progress(current, faces=0, done=False, clusters=None):
        ws = progress_sessions.get(event_id)
        if ws and ws.client_state == WebSocketState.CONNECTED:
            msg = {
                "type": "progress",
                "current": current,
                "total": total,
                "faces": faces
            }
            if done:
                msg["type"] = "done"
                msg["clusters"] = clusters

            try:
                await ws.send_json(msg)
            except Exception:
                pass

    # -----------------------------------------------------
    # MAIN IMAGE LOOP
    # -----------------------------------------------------
    for i, img_path in enumerate(imgs, 1):
        face_count = 0

        try:
            # Detect faces
            faces = DeepFace.represent(
                img_path,
                model_name=model_name,
                detector_backend=detector_backend,
                enforce_detection=False
            )

            # -------------------------------------------------
            # DEDUPLICATE multiple-face duplicates
            # -------------------------------------------------
            unique_faces = []
            seen = []

            for f in faces:
                emb = np.array(f["embedding"], dtype=np.float32)
                emb_norm = emb / (np.linalg.norm(emb) + 1e-10)

                is_duplicate = False
                for prev in seen:
                    sim = np.dot(emb_norm, prev)
                    if sim > 0.98:     # same face returned twice by DeepFace
                        is_duplicate = True
                        break

                if not is_duplicate:
                    seen.append(emb_norm)
                    unique_faces.append(emb)

            # Save unique faces
            face_count = len(unique_faces)
            for emb in unique_faces:
                embeds.append(emb)
                meta.append({"photo": img_path})

            logger.info("[%d/%d] %s — %d faces",
                        i, total, os.path.basename(img_path), face_count)

        except Exception as e:
            logger.warning("Failed %s: %s", img_path, e)

        await send_progress(i, face_count)
        await asyncio.sleep(0.05)

    # -----------------------------------------------------
    # EMBEDDINGS DONE
    # -----------------------------------------------------
    if not embeds:
        raise ValueError("No faces detected.")

    embeds = np.array(embeds, dtype=np.float32)
    embeds /= np.clip(np.linalg.norm(embeds, axis=1, keepdims=True), 1e-10, None)

    # -----------------------------------------------------
    # FAISS Index
    # -----------------------------------------------------
    faiss_path = os.path.join(output_dir, "faces.index")
    index = faiss.IndexFlatIP(embeds.shape[1])
    index.add(embeds)
    faiss.write_index(index, faiss_path)

    # -----------------------------------------------------
    # HDBSCAN Clustering
    # -----------------------------------------------------
    hparams = choose_hdbscan_params(len(embeds))
    clusterer = hdbscan.HDBSCAN(metric="euclidean", **hparams)
    labels = clusterer.fit_predict(embeds)

    # -----------------------------------------------------
    # SAVE DATABASE
    # -----------------------------------------------------
    db_path = os.path.join(output_dir, "face_database.pkl")
    db = {
        "embeddings": embeds,
        "metadata": meta,
        "cluster_labels": labels,
        "faiss_index_path": faiss_path,
        "detector_backend": detector_backend
    }

    with open(db_path, "wb") as f:
        pickle.dump(db, f)

    clusters = len(set(labels)) - (1 if -1 in labels else 0)

    logger.info("Completed (%d clusters). Time: %.2fs", clusters, time)


    await send_progress(total, done=True, clusters=clusters)

    return {
        "faces": len(embeds),
        "clusters": clusters,
        "log": logfile
    }



# -------------------------------------------------------------
# FACE SEARCH
# -------------------------------------------------------------
def search_face(query_img: str, threshold=0.7):
    if not os.path.exists("face_database.pkl") or not os.path.exists("faces.index"):
        raise FileNotFoundError("No index found.")
    with open("face_database.pkl", "rb") as f:
        db = pickle.load(f)

    index = faiss.read_index(db["faiss_index_path"])
    faces = DeepFace.represent(query_img, model_name="Facenet512",
                               detector_backend=db["detector_backend"], enforce_detection=False)
    if not faces:
        raise ValueError("No face detected.")
    emb = np.array(faces[0]["embedding"], dtype=np.float32)
    emb /= np.linalg.norm(emb) + 1e-10
    emb = emb[None, :]

    dist, ind = index.search(emb, 1000)
    results = []
    for idx, d in zip(ind[0], dist[0]):
        if d >= threshold:
            results.append({"photo": to_relative(db["metadata"][idx]["photo"]), "similarity": float(d)})

    return {"matches": sorted(results, key=lambda x: -x["similarity"])}


# -------------------------------------------------------------
# WEBSOCKET PROGRESS ENDPOINT
# -------------------------------------------------------------
@app.websocket("/ws/progress/{event_id}")
async def websocket_progress(ws: WebSocket, event_id: str):
    await ws.accept()
    progress_sessions[event_id] = ws
    print(f"[ws] Connected: {event_id}")
    try:
        while True:
            if ws.client_state == WebSocketState.DISCONNECTED:
                break
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        print(f"[ws] Disconnected: {event_id}")
    finally:
        progress_sessions.pop(event_id, None)

# ... (all your imports and setup remain the same above)

# -------------------------------------------------------------
# PROJECT UPLOAD ENDPOINT — UPDATED
# -------------------------------------------------------------
@app.post("/api/projects/")
async def upload_project(
    project_user_name: str = Form(...),
    project_data: str = Form(...),
    cover: Optional[UploadFile] = File(None),
    event_covers: Optional[List[UploadFile]] = File(None),
    photos: Optional[List[UploadFile]] = File(None),
):
    try:
        proj = json.loads(project_data)
        slug = re.sub(r"[^A-Za-z0-9_.-]+", "_", proj.get("name", f"project_{uuid4().hex[:6]}"))
        root = UPLOADS_DIR / project_user_name / slug
        root.mkdir(parents=True, exist_ok=True)

        meta = {"project": slug, "events": []}
        photo_idx = 0

        for i, e in enumerate(proj.get("events", [])):
            e_name = e.get("name", f"event_{i+1}")
            e_slug = re.sub(r"[^A-Za-z0-9_-]+", "_", e_name)
            e_folder = root / e_slug
            imgs_folder = e_folder / "images"
            imgs_folder.mkdir(parents=True, exist_ok=True)

            # Save uploaded event photos
            for _ in e.get("assets", []):
                if photos and photo_idx < len(photos):
                    p = photos[photo_idx]
                    path = imgs_folder / safe_filename(p.filename)
                    with open(path, "wb") as f:
                        f.write(await p.read())
                    photo_idx += 1

            # 🟢 Use the frontend-provided event ID if available
            event_id = e.get("id") or str(uuid.uuid4())[:8]
            print(f"[UPLOAD] Processing event '{e_name}' with ID: {event_id}")

            # Start processing if there are images
            if any(imgs_folder.iterdir()):
                res = await process_faces(str(imgs_folder), str(e_folder), event_id=event_id)
                meta["events"].append({"name": e_name, "event_id": event_id, "result": res})
            else:
                meta["events"].append({"name": e_name, "event_id": event_id, "result": "no_images"})

        # Compress all uploaded images in background
        threading.Thread(target=compress_all_images, args=(root,), daemon=True).start()

        return JSONResponse(content={
            "message": "✅ Project processed successfully",
            "data": meta
        }, status_code=200)

    except Exception as e:
        tb = traceback.format_exc()
        print("❌ Upload error:", tb)
        return JSONResponse(status_code=500, content={"error": str(e), "traceback": tb})

# -------------------------------------------------------------
# SEARCH ENDPOINT (verbose with prints)
# -------------------------------------------------------------
@app.post("/api/search-face/")
async def api_search_face(
    photo: UploadFile = File(...),
    threshold: float = Form(0.7),
    project_user_name: Optional[str] = Form(None),
    project_slug: Optional[str] = Form(None),
    event_slug: Optional[str] = Form(None),
):
    try:
        print("\n🔍 [SEARCH] New search request received")
        print(f"├─ User: {project_user_name}")
        print(f"├─ Project: {project_slug}")
        print(f"├─ Event: {event_slug}")
        print(f"├─ Threshold: {threshold}")

        # Resolve event directory and tmp folder
        event_dir = UPLOADS_DIR / (project_user_name or "") / (project_slug or "") / (event_slug or "")
        tmp = event_dir / "tmp_search"
        tmp.mkdir(parents=True, exist_ok=True)

        # Save uploaded photo
        path = tmp / safe_filename(photo.filename)
        with open(path, "wb") as f:
            f.write(await photo.read())
        print(f"├─ Uploaded file saved to: {path}")

        # Check if index exists
        face_db_path = event_dir / "face_database.pkl"
        faiss_index_path = event_dir / "faces.index"
        if not face_db_path.exists() or not faiss_index_path.exists():
            print("❌ [SEARCH] Missing index or database file.")
            return JSONResponse(
                content={"error": "Event not processed yet — no face database found."},
                status_code=400,
            )

        # Perform face search
        os.chdir(event_dir)
        print("├─ Running face search...")
        result = search_face(str(path), threshold=threshold)

        # Print summary
        total_matches = len(result.get("matches", []))
        print(f"✅ [SEARCH] Found {total_matches} matches for query {path.name}")
        if total_matches > 0:
            print("   Top results:")
            for m in result["matches"][:3]:
                print(f"     → {m['photo']}  (sim={m['similarity']:.3f})")

        return JSONResponse(
            content={
                "query": to_relative(str(path)),
                "results": result,
                "message": f"Found {total_matches} matches",
            },
            status_code=200,
        )

    except Exception as e:
        tb = traceback.format_exc()
        print("❌ [SEARCH ERROR]:", tb)
        return JSONResponse(status_code=500, content={"error": str(e), "traceback": tb})
