#!/usr/bin/env python3
"""
process_faces_with_logs.py

Usage:
    python process_faces_with_logs.py /path/to/dataset_dir [--model Facenet512] [--detector retinaface]
"""

import os
import sys
import time
import pickle
import logging
from logging.handlers import RotatingFileHandler
import argparse
from glob import glob
import traceback
import numpy as np
from PIL import Image, UnidentifiedImageError

# DeepFace, FAISS, HDBSCAN
from deepface import DeepFace
import faiss
import hdbscan

# Optional visualization libraries
try:
    import umap
except Exception:
    umap = None

try:
    import matplotlib.pyplot as plt
except Exception:
    plt = None


# -------------------------------------------------------------------
# LOGGING SETUP (Now supports custom log_dir)
# -------------------------------------------------------------------
def setup_logging(log_dir="logs"):
    os.makedirs(log_dir, exist_ok=True)
    logfile = os.path.join(log_dir, "process_faces.log")  # fixed name per event folder

    logger = logging.getLogger("face_processor")

    # Clear handlers if re-used
    if logger.hasHandlers():
        logger.handlers.clear()

    logger.setLevel(logging.DEBUG)

    # Console handler
    ch = logging.StreamHandler(sys.stdout)
    ch.setLevel(logging.INFO)
    ch_fmt = logging.Formatter("%(asctime)s | %(levelname)-7s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    ch.setFormatter(ch_fmt)

    # File handler
    fh = RotatingFileHandler(logfile, maxBytes=5_000_000, backupCount=5, encoding="utf-8")
    fh.setLevel(logging.DEBUG)
    fh_fmt = logging.Formatter("%(asctime)s | %(levelname)-7s | %(name)s | %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    fh.setFormatter(fh_fmt)

    logger.addHandler(ch)
    logger.addHandler(fh)

    return logger, logfile


# -------------------------------------------------------------------
# HELPER FUNCTIONS
# -------------------------------------------------------------------
def choose_hdbscan_params(n_vectors):
    if n_vectors < 100:
        return dict(min_cluster_size=3, min_samples=1)
    elif n_vectors < 500:
        return dict(min_cluster_size=5, min_samples=3)
    elif n_vectors < 2000:
        return dict(min_cluster_size=8, min_samples=5)
    else:
        return dict(
            min_cluster_size=max(15, int(0.01 * n_vectors)),
            min_samples=max(5, int(0.01 * n_vectors) // 2),
        )


# -------------------------------------------------------------------
# MAIN PROCESSING FUNCTION
# -------------------------------------------------------------------
def process_faces(
    dataset_dir: str,
    model_name="Facenet512",
    detector_backend="retinaface",
    use_umap_if_large=True,
    umap_dims=64,
    random_state=42,
    save_clusterer=False,
    visualize=True,
    output_dir=".",
    log_dir=None,
):
    """Process all faces in a dataset directory into embeddings, clusters, and FAISS index."""

    # ✅ Setup logging per event
    if not log_dir:
        log_dir = os.path.join(output_dir, "logs")
    logger, LOGFILE = setup_logging(log_dir)

    start_time = time.time()
    logger.info("Starting face processing for directory: %s", dataset_dir)

    # Gather all images
    patterns = ["*.jpg", "*.jpeg", "*.png", "*.JPG", "*.JPEG", "*.PNG"]
    image_paths = []
    for pat in patterns:
        image_paths.extend(glob(os.path.join(dataset_dir, "**", pat), recursive=True))

    # Filter irrelevant images
    image_paths = [
        p for p in image_paths
        if not any(x in p.lower() for x in ["/logs/", "/thumbs/", "cover.jpg", "cover.png"])
    ]

    if not image_paths:
        logger.error("No valid images found in dataset: %s", dataset_dir)
        raise ValueError(f"No images found in {dataset_dir}")

    logger.info("Found %d images to process", len(image_paths))
    all_embeddings, all_metadata = [], []

    # Face detection and embeddings
    for idx, photo in enumerate(sorted(image_paths), 1):
        logger.info("[%d/%d] Processing %s", idx, len(image_paths), os.path.basename(photo))
        try:
            with Image.open(photo) as im:
                im.verify()
        except (UnidentifiedImageError, OSError) as ex:
            logger.warning("Invalid image skipped: %s — %s", photo, ex)
            continue

        try:
            faces = DeepFace.represent(
                img_path=photo,
                model_name=model_name,
                detector_backend=detector_backend,
                enforce_detection=False,
            )
            if faces:
                for face_idx, f in enumerate(faces):
                    emb = np.array(f["embedding"], dtype=np.float32)
                    all_embeddings.append(emb)
                    all_metadata.append({"photo": photo, "face_index": face_idx})
                logger.info("Detected %d face(s)", len(faces))
            else:
                logger.info("No faces detected in %s", os.path.basename(photo))
        except Exception as ex:
            logger.exception("DeepFace failed on %s: %s", photo, ex)
            continue

    if not all_embeddings:
        logger.error("No embeddings extracted.")
        raise ValueError("No faces detected in dataset")

    embeddings = np.array(all_embeddings, dtype=np.float32)
    n_vectors = embeddings.shape[0]
    logger.info("Extracted %d embeddings (dim=%d)", n_vectors, embeddings.shape[1])

    # Normalize
    embeddings /= np.clip(np.linalg.norm(embeddings, axis=1, keepdims=True), 1e-10, None)

    # FAISS index
    index = faiss.IndexFlatIP(embeddings.shape[1])
    index.add(embeddings)
    faces_index_path = os.path.join(output_dir, "faces.index")
    faiss.write_index(index, faces_index_path)
    logger.info("Saved FAISS index → %s", faces_index_path)

    # Clustering
    hparams = choose_hdbscan_params(n_vectors)
    emb_for_clustering = embeddings
    used_umap = False

    if use_umap_if_large and umap and n_vectors > 500:
        try:
            logger.info("Running UMAP for %d→%d dims ...", embeddings.shape[1], umap_dims)
            reducer = umap.UMAP(n_components=umap_dims, metric="cosine", random_state=random_state)
            emb_for_clustering = reducer.fit_transform(embeddings)
            used_umap = True
            logger.info("UMAP reduced to %d dims", emb_for_clustering.shape[1])
        except Exception:
            logger.exception("UMAP failed — using raw embeddings.")
            emb_for_clustering = embeddings

    try:
        clusterer = hdbscan.HDBSCAN(
            min_cluster_size=hparams["min_cluster_size"],
            min_samples=hparams["min_samples"],
            metric="cosine",
            cluster_selection_method="eom",
            prediction_data=True,
            core_dist_n_jobs=4,
        )
        cluster_labels = clusterer.fit_predict(emb_for_clustering)
        logger.info("HDBSCAN completed with %d clusters.", len(set(cluster_labels)) - (1 if -1 in cluster_labels else 0))
    except Exception:
        logger.exception("HDBSCAN failed.")
        cluster_labels = np.array([-1] * n_vectors, dtype=int)

    # Save pickle
    db = {
        "embeddings": embeddings,
        "metadata": all_metadata,
        "cluster_labels": cluster_labels,
        "faiss_index_path": faces_index_path,
        "detector_backend": detector_backend,
        "hdbscan_params": hparams,
    }

    if save_clusterer:
        db["hdbscan_clusterer"] = clusterer

    db_path = os.path.join(output_dir, "face_database.pkl")
    with open(db_path, "wb") as f:
        pickle.dump(db, f)
    logger.info("Saved database → %s", db_path)

    elapsed = time.time() - start_time
    logger.info("Processing finished in %.2f seconds", elapsed)

    return {
        "total_images": len(image_paths),
        "total_faces": n_vectors,
        "clusters": len(set(cluster_labels)) - (1 if -1 in cluster_labels else 0),
        "faces_index": faces_index_path,
        "database": db_path,
        "log_file": LOGFILE,
    }


# -------------------------------------------------------------------
# CLI ENTRYPOINT (for manual use)
# -------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Face clustering with DeepFace + HDBSCAN")
    parser.add_argument("dataset_dir", help="Dataset directory with images")
    parser.add_argument("--model", default="Facenet512")
    parser.add_argument("--detector", default="retinaface")
    parser.add_argument("--no-umap", action="store_true")
    parser.add_argument("--output-dir", default=".")
    parser.add_argument("--log-dir", default=None)
    parser.add_argument("--no-vis", action="store_true")
    args = parser.parse_args()

    try:
        result = process_faces(
            dataset_dir=args.dataset_dir,
            model_name=args.model,
            detector_backend=args.detector,
            use_umap_if_large=not args.no_umap,
            visualize=not args.no_vis,
            output_dir=args.output_dir,
            log_dir=args.log_dir,
        )
        print("✅ Completed successfully:", result)
    except Exception as e:
        print("❌ Failed:", e)
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
