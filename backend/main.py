# face_api_arcface_gpu_norm.py
"""
ArcFace (InsightFace) + FAISS face indexing & search.
Scoring mode: Normalized 0..1 (score = (cosine + 1) / 2).
Default UI threshold ~0.75 (same-person).
Includes:
 - Robust InsightFace init (GPU then CPU fallback)
 - L2-normalized embeddings saved to FAISS (IndexFlatIP)
 - Optional auto-tune of threshold from cluster stats
 - UTF-8-safe logging for Windows
 - Websocket progress support
 - FAISS search returning normalized similarity scores
Notes:
 - First-time FaceAnalysis.prepare(...) may download models and can take time.
 - If InsightFace fails due to CUDA/onnx/runtime issues, the exception explains next steps.
"""
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
import logging
from logging.handlers import RotatingFileHandler
from glob import glob

import numpy as np
from PIL import Image
import cv2  # insightface requires cv2 available
import faiss
import hdbscan

from fastapi import FastAPI, UploadFile, File, Form, WebSocket, WebSocketDisconnect
from fastapi.websockets import WebSocketState
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# InsightFace (ArcFace)
try:
    from insightface.app import FaceAnalysis
except Exception as e:
    raise RuntimeError(
        "insightface import failed. Install with:\n"
        "  pip install insightface onnxruntime-gpu opencv-python-headless\n\n"
        f"Original import error: {e}"
    )

# -------------------------
# Config
# -------------------------
BUNDLE = "buffalo_l"  # retinaface + arcface r100 bundle (512d)
DEFAULT_THRESHOLD_NORM = 0.75  # normalized (0..1) threshold for same-person
MIN_TUNE_THRESHOLD = 0.65
MAX_TUNE_THRESHOLD = 0.85

# -------------------------
# Paths / FastAPI init
# -------------------------
BASE_DIR = Path(__file__).resolve().parent
UPLOADS_DIR = BASE_DIR / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Face Project API (ArcFace GPU Norm)", version="1.0")
app.mount("/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")

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

# -------------------------
# Globals
# -------------------------
progress_sessions = {}  # event_id -> websocket
face_app = None
face_app_ctx = None  # >=0 => GPU, -1 => CPU

# -------------------------
# Helpers
# -------------------------
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
        print(f"[compress] {src_path.name}")
        return True
    except Exception as e:
        print(f"[compress] {src_path}: {e}")
        return False

def compress_all_images(folder: Path):
    count = 0
    for img in folder.rglob("*.[jp][pn]g"):
        if any(x in str(img).lower() for x in ["faces", "embedding", "logs", "tmp_search"]):
            continue
        if compress_image_file(img):
            count += 1
    print(f"[compress] Compressed {count} images in {folder.name}")

def to_relative(p: str):
    if not p:
        return p
    p = p.replace("\\", "/")
    i = p.lower().find("/uploads/")
    return p[i:] if i >= 0 else p

# -------------------------
# Logging (utf-8 safe)
# -------------------------
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

    fh = RotatingFileHandler(logfile, maxBytes=10_000_000, backupCount=5, encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh.setFormatter(logging.Formatter("%(asctime)s | %(levelname)-7s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))

    logger.addHandler(ch)
    logger.addHandler(fh)
    return logger, logfile

# -------------------------
# HDBSCAN params helper
# -------------------------
def choose_hdbscan_params(n):
    if n < 100:
        return dict(min_cluster_size=3, min_samples=1)
    if n < 500:
        return dict(min_cluster_size=5, min_samples=3)
    if n < 2000:
        return dict(min_cluster_size=8, min_samples=5)
    return dict(min_cluster_size=max(15, int(0.01 * n)), min_samples=max(5, int(0.005 * n)))

# -------------------------
# InsightFace init (robust)
# -------------------------
def init_insightface(bundle_name: str = BUNDLE, prefer_gpu: bool = True, det_size=(640, 640)):
    """
    Try to init InsightFace FaceAnalysis.
    prefer_gpu: if True try ctx_id=0 (GPU) first, else start with CPU.
    Returns (face_app, ctx_id) where ctx_id >=0 => GPU, -1 => CPU.
    Raises RuntimeError with actionable message on failure.
    """
    global face_app, face_app_ctx
    last_exc = None
    # Try GPU first if preferred
    ctx_try_order = [0, -1] if prefer_gpu else [-1, 0]
    for ctx in ctx_try_order:
        try:
            fa = FaceAnalysis(name=bundle_name)
            # prepare may download model once (slow). Log time.
            t0 = time.time()
            fa.prepare(ctx_id=ctx, det_size=det_size)
            # success
            face_app = fa
            face_app_ctx = ctx
            return fa, ctx
        except AssertionError as ae:
            # insightface may raise AssertionError if models not present
            last_exc = ae
            # try next ctx
        except Exception as e:
            last_exc = e
            # try next
    # all failed
    raise RuntimeError(
        "Failed to initialize InsightFace. Usually caused by missing models, CUDA/onnxruntime mismatch, or broken cache.\n"
        "Hints:\n"
        " - Ensure onnxruntime-gpu (if using GPU) or onnxruntime (CPU) matches your CUDA/cuDNN and Python.\n"
        " - If you changed CUDA, remove insightface cache in %USERPROFILE%/.insightface or ~/.insightface to force re-download.\n"
        " - Try ctx_id=-1 (CPU) explicitly to check CPU-only.\n\n"
        f"Last exception: {last_exc}"
    )

# Initialize once at import (try GPU then CPU)
try:
    face_app, face_app_ctx = init_insightface(prefer_gpu=True)
    print(f"[init] InsightFace initialized. ctx={face_app_ctx} (>=0 GPU, -1 CPU).")
except Exception as e:
    # re-raise with helpful message
    raise

# -------------------------
# ArcFace extractor
# -------------------------
def extract_faces_arcface(image_path: str):
    """
    Detect faces and return list of dicts:
      { "embedding": np.ndarray(512,), "bbox": [x1,y1,x2,y2], "det_score": float }
    Embeddings are NOT re-normalized here; caller will L2-normalize before indexing.
    """
    try:
        img = np.array(Image.open(image_path).convert("RGB"))
    except Exception:
        return []

    faces = face_app.get(img)  # insightface Face objects
    results = []
    for f in faces:
        emb = None
        if hasattr(f, "normed_embedding") and f.normed_embedding is not None:
            emb = np.array(f.normed_embedding, dtype=np.float32)
            # normed_embedding is already unit norm
        elif hasattr(f, "embedding") and f.embedding is not None:
            emb = np.array(f.embedding, dtype=np.float32)
            # normalize here (safety)
            emb = emb / (np.linalg.norm(emb) + 1e-10)
        else:
            continue

        bbox = f.bbox.astype(int).tolist() if hasattr(f, "bbox") else None
        det_score = float(f.det_score) if hasattr(f, "det_score") else None

        results.append({"embedding": emb, "bbox": bbox, "det_score": det_score})
    return results

# -------------------------
# Auto threshold tuner
# -------------------------
def auto_tune_threshold_from_clusters(embeddings: np.ndarray, labels: np.ndarray, default_norm=DEFAULT_THRESHOLD_NORM):
    """
    Given normalized embeddings (rows L2=1) and cluster labels,
    compute intra-cluster cosine similarities and estimate a sensible normalized threshold.
    Returns threshold_norm (0..1).
    """
    if len(embeddings) < 10:
        return default_norm

    sims = []
    for lab in set(labels):
        if lab == -1:
            continue
        idx = np.where(labels == lab)[0]
        if len(idx) < 2:
            continue
        # sample pairs (up to 300 pairs) to compute intra-cluster sims
        i_idx = idx
        if len(i_idx) > 200:
            i_idx = np.random.choice(i_idx, 200, replace=False)
        m = embeddings[i_idx]  # normalized vectors
        # pairwise dot products upper triangle
        dotp = m @ m.T
        iu = np.triu_indices(dotp.shape[0], k=1)
        svals = dotp[iu]
        sims.extend(svals.tolist())
    if not sims:
        return default_norm
    sims = np.array(sims, dtype=np.float32)
    mean = sims.mean()
    std = sims.std()
    # choose threshold a bit below mean (conservative) but within bounds
    # normalized score = (cos+1)/2
    mean_norm = (mean + 1.0) / 2.0
    # push threshold slightly lower than mean to reduce false negatives
    thr = mean_norm - 0.12  # heuristic
    thr = float(max(MIN_TUNE_THRESHOLD, min(MAX_TUNE_THRESHOLD, thr)))
    return thr

# -------------------------
# PROCESS FACES (async)
# -------------------------
async def process_faces(dataset_dir: str, output_dir: str, event_id: str, threshold_norm: Optional[float] = None):
    """
    Walk dataset_dir recursively, detect faces, extract embeddings with ArcFace, build FAISS index,
    cluster with HDBSCAN, save face_database.pkl and faces.index in output_dir.
    Returns dict with counts and logfile path.
    """
    log_dir = os.path.join(output_dir, "logs")
    logger, logfile = setup_logging(log_dir)
    start = time.time()

    logger.info("Starting face processing for: %s", dataset_dir)

    # gather images
    imgs = []
    for pat in ["*.jpg", "*.jpeg", "*.png", "*.JPG", "*.PNG"]:
        imgs.extend(glob(os.path.join(dataset_dir, "**", pat), recursive=True))
    imgs = list(dict.fromkeys(imgs))
    imgs = [p for p in imgs if not any(x in p.lower() for x in ["cover", "logs", "thumb"])]
    imgs = sorted(imgs)

    total = len(imgs)
    if total == 0:
        raise ValueError("No images found.")

    logger.info("Found %d unique images", total)

    embeds = []
    meta = []  # {"photo": path, "bbox": bbox}

    async def send_progress(current, faces=0, done=False, clusters=None):
        ws = progress_sessions.get(event_id)
        if ws and ws.client_state == WebSocketState.CONNECTED:
            msg = {"type": "progress", "current": current, "total": total, "faces": faces}
            if done:
                msg.update({"type": "done", "clusters": clusters})
            try:
                await ws.send_json(msg)
            except Exception:
                pass

    # main loop: detect + dedupe within image
    for i, img_path in enumerate(imgs, 1):
        face_count = 0
        try:
            faces = extract_faces_arcface(img_path)
            # dedupe embeddings within same image
            unique = []
            seen = []
            for f in faces:
                emb = f["embedding"].astype(np.float32)
                # ensure normalized
                emb_norm = emb / (np.linalg.norm(emb) + 1e-10)
                duplicate = False
                for prev in seen:
                    sim = float(np.dot(emb_norm, prev))
                    if sim > 0.995:
                        duplicate = True
                        break
                if not duplicate:
                    seen.append(emb_norm)
                    unique.append((emb_norm, f.get("bbox")))

            face_count = len(unique)
            for emb_norm, bbox in unique:
                embeds.append(emb_norm)
                meta.append({"photo": img_path, "bbox": bbox})

            logger.info("[%d/%d] %s — %d faces", i, total, os.path.basename(img_path), face_count)
        except Exception as e:
            logger.warning("Failed %s: %s", img_path, e)

        await send_progress(i, face_count)
        await asyncio.sleep(0.01)

    if not embeds:
        raise ValueError("No faces detected.")

    embeds = np.array(embeds, dtype=np.float32)
    # already normalized per-face above, but ensure robustly:
    embeds /= np.clip(np.linalg.norm(embeds, axis=1, keepdims=True), 1e-10, None)

    # FAISS index (IndexFlatIP on normalized vectors -> cosine as inner product)
    faiss_path = os.path.join(output_dir, "faces.index")
    index = faiss.IndexFlatIP(embeds.shape[1])
    index.add(embeds)
    faiss.write_index(index, faiss_path)

    # HDBSCAN clustering
    hparams = choose_hdbscan_params(len(embeds))
    clusterer = hdbscan.HDBSCAN(metric="euclidean", **hparams)
    try:
        labels = clusterer.fit_predict(embeds)
    except Exception as e:
        # if HDBSCAN fails, fall back to all -1 labels
        logger.warning("HDBSCAN failed: %s", e)
        labels = np.full(len(embeds), -1, dtype=int)

    # Auto-tune threshold if requested
    if threshold_norm is None:
        tuned = auto_tune_threshold_from_clusters(embeds, labels, default_norm=DEFAULT_THRESHOLD_NORM)
        threshold_norm = tuned
    # clamp
    threshold_norm = float(max(0.0, min(1.0, threshold_norm)))

    # Save database / metadata
    db_path = os.path.join(output_dir, "face_database.pkl")
    db = {
        "embeddings": embeds,
        "metadata": meta,
        "cluster_labels": labels,
        "faiss_index_path": faiss_path,
        "model": f"arcface_{BUNDLE}",
        "threshold_norm": threshold_norm,
        "face_app_ctx": face_app_ctx
    }
    with open(db_path, "wb") as f:
        pickle.dump(db, f, protocol=pickle.HIGHEST_PROTOCOL)

    clusters = len(set(labels)) - (1 if -1 in labels else 0)
    logger.info("Completed (%d clusters). Time: %.2fs. threshold_norm=%.3f", clusters, time.time() - start, threshold_norm)

    await send_progress(total, done=True, clusters=clusters)
    return {"faces": len(embeds), "clusters": clusters, "threshold_norm": threshold_norm, "log": logfile}

# -------------------------
# Search face
# -------------------------
def search_face(query_img: str, event_dir: str, threshold_norm: float = DEFAULT_THRESHOLD_NORM, top_k: int = 1000):
    """
    Search for matches in an event directory (face_database.pkl and faces.index expected).
    Returns matches with normalized similarity scores (0..1).
    """
    db_path = os.path.join(event_dir, "face_database.pkl")
    faiss_index_path = os.path.join(event_dir, "faces.index")
    if not os.path.exists(db_path) or not os.path.exists(faiss_index_path):
        raise FileNotFoundError("No index found for event.")

    with open(db_path, "rb") as f:
        db = pickle.load(f)

    index = faiss.read_index(db["faiss_index_path"])

    q_faces = extract_faces_arcface(query_img)
    if not q_faces:
        raise ValueError("No face detected in query image.")

    q_emb = np.array(q_faces[0]["embedding"], dtype=np.float32)
    q_emb /= (np.linalg.norm(q_emb) + 1e-10)
    q_emb = q_emb[None, :]

    dist, ind = index.search(q_emb, top_k)  # dist here is inner product (cosine) because vectors normalized
    results = []
    for idx, d in zip(ind[0], dist[0]):
        # d is cosine in [-1,1], convert to normalized 0..1
        norm_score = float((d + 1.0) / 2.0)
        if norm_score >= threshold_norm:
            meta_item = db["metadata"][idx]
            results.append({
                "photo": to_relative(meta_item.get("photo", "")),
                "similarity": norm_score,
                "bbox": meta_item.get("bbox")
            })

    return {"matches": sorted(results, key=lambda x: -x["similarity"])}

# -------------------------
# Websocket progress endpoint
# -------------------------
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

# -------------------------
# Project upload endpoint
# -------------------------
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

            event_id = e.get("id") or str(uuid.uuid4())[:8]
            print(f"[UPLOAD] Processing event '{e_name}' with ID: {event_id}")

            if any(imgs_folder.iterdir()):
                res = await process_faces(str(imgs_folder), str(e_folder), event_id=event_id)
                meta["events"].append({"name": e_name, "event_id": event_id, "result": res})
            else:
                meta["events"].append({"name": e_name, "event_id": event_id, "result": "no_images"})

        # compress images in background
        threading.Thread(target=compress_all_images, args=(root,), daemon=True).start()

        return JSONResponse(content={"message": "Project processed successfully", "data": meta}, status_code=200)
    except Exception as e:
        tb = traceback.format_exc()
        print("Upload error:", tb)
        return JSONResponse(status_code=500, content={"error": str(e), "traceback": tb})

# -------------------------
# Search endpoint
# -------------------------
@app.post("/api/search-face/")
async def api_search_face(
    photo: UploadFile = File(...),
    threshold: float = Form(DEFAULT_THRESHOLD_NORM),
    project_user_name: Optional[str] = Form(None),
    project_slug: Optional[str] = Form(None),
    event_slug: Optional[str] = Form(None),
):
    try:
        print("\n[SEARCH] New search request received")
        print(f"User: {project_user_name}  Project: {project_slug}  Event: {event_slug}  Th(norm): {threshold}")

        event_dir = UPLOADS_DIR / (project_user_name or "") / (project_slug or "") / (event_slug or "")
        tmp = event_dir / "tmp_search"
        tmp.mkdir(parents=True, exist_ok=True)

        # save query image
        path = tmp / safe_filename(photo.filename)
        with open(path, "wb") as f:
            f.write(await photo.read())
        print(f"Uploaded file saved to: {path}")

        # check index exists
        face_db_path = event_dir / "face_database.pkl"
        faiss_index_path = event_dir / "faces.index"
        if not face_db_path.exists() or not faiss_index_path.exists():
            print("[SEARCH] Missing index or database file.")
            return JSONResponse(content={"error": "Event not processed yet — no face database found."}, status_code=400)

        result = search_face(str(path), str(event_dir), threshold_norm=float(threshold))
        total_matches = len(result.get("matches", []))
        print(f"[SEARCH] Found {total_matches} matches for query {path.name}")

        return JSONResponse(content={"query": to_relative(str(path)), "results": result, "message": f"Found {total_matches} matches"}, status_code=200)
    except Exception as e:
        tb = traceback.format_exc()
        print("SEARCH ERROR:", tb)
        return JSONResponse(status_code=500, content={"error": str(e), "traceback": tb})
