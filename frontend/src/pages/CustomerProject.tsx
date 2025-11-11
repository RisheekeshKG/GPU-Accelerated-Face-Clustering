'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import FooterCustomer from '../components/FooterCustomer';
import PasswordModal from '../components/PasswordModal';
import { comparePassword, incrementImpression, incrementView, loadStore } from '../utils/storage';

export default function CustomerProject() {
  const { slug } = useParams<{ slug: string }>();
  const store = loadStore();
  const project = store.projects.find(p => p.slug === slug);
  const [unlocked, setUnlocked] = useState(!project?.protected);
  const [tab, setTab] = useState<'album' | 'find'>('album');
  const [activeEventId, setActiveEventId] = useState<string | undefined>(project?.events[0]?.id);

  useEffect(() => {
    if (project) {
      incrementView(project.id);
    }
  }, [project?.id]);

  useEffect(() => {
    if (project) {
      const interval = setInterval(() => incrementImpression(project.id), 5000);
      return () => clearInterval(interval);
    }
  }, [project?.id]);

  if (!project) return <div className="p-6">Project not found.</div>;

  const activeEvent = useMemo(
    () => project.events.find(e => e.id === activeEventId) || project.events[0],
    [project, activeEventId]
  );

  return (
    <div className="pb-20">
      {!unlocked && (
        <PasswordModal
          onClose={() => {}}
          onSubmit={(pwd) => {
            if (project.passwordHash && comparePassword(pwd, project.passwordHash)) {
              setUnlocked(true);
            } else {
              alert('Incorrect password');
            }
          }}
        />
      )}

      <div className="w-full h-56 bg-gray-100 overflow-hidden">
        {project.coverUrl ? (
          <img src={project.coverUrl} alt={project.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full grid place-items-center text-gray-500">No cover</div>
        )}
      </div>

      <div className="container-app px-4 py-4">
        <h1 className="text-2xl font-semibold mb-3">{project.name}</h1>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          {project.events.map(e => (
            <button
              key={e.id}
              onClick={() => setActiveEventId(e.id)}
              className={`border rounded overflow-hidden text-left ${activeEventId === e.id ? 'ring-2 ring-black' : ''}`}
            >
              <div className="w-full h-24 bg-gray-100 overflow-hidden">
                {e.coverUrl ? (
                  <img src={e.coverUrl} className="w-full h-full object-cover" alt={e.name} />
                ) : e.assets[0] ? (
                  <img src={e.assets[0].url} className="w-full h-full object-cover" alt={e.name} />
                ) : (
                  <div className="w-full h-full grid place-items-center text-gray-500">No image</div>
                )}
              </div>
              <div className="p-2 text-sm">{e.name}</div>
            </button>
          ))}
        </div>

        {tab === 'album' && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {activeEvent?.assets.map(a => (
              <img key={a.id} src={a.url} alt={a.name} className="w-full h-40 object-cover rounded" />
            ))}
            {(!activeEvent || activeEvent.assets.length === 0) && (
              <div className="col-span-full text-center text-gray-600">No photos available.</div>
            )}
          </div>
        )}

        {tab === 'find' && <FindYourImage />}
      </div>

      <FooterCustomer tab={tab} onTab={setTab} />
    </div>
  );
}

// === FindYourImage Component (Fixed & Typed) ===
function FindYourImage() {
  const [preview, setPreview] = useState<string | null>(null);
  const [choices, setChoices] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [related, setRelated] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const relatedMap: Record<string, string[]> = {
    '😊': ['😀', '😄', '😁', '🙂'],
    '🎉': ['🎊', '🎈', '🥳', '🎂'],
    '💃': ['🕺', '🎶', '✨', '🎵'],
    '🕺': ['💃', '🎵', '🎶', '✨']
  };

  // Open camera modal
  const openModal = async () => {
    try {
      // Stop existing stream
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 300 },
          height: { ideal: 300 }
        }
      });

      streamRef.current = stream;
      setOpen(true);
      setPreview(null);
      setChoices([]);
      setSelected(null);
      setRelated([]);

      setTimeout(() => {
        const video = videoRef.current;
        if (video && streamRef.current) {
          video.srcObject = streamRef.current;
          video.muted = true;
          video.playsInline = true;

          video.onloadedmetadata = () => {
            video.play().catch((err: Error) => {
              console.error('Video play failed:', err);
            });
          };
        }
      }, 100);
    } catch (err) {
      console.error('Camera access failed:', err);
      alert('Camera access denied. Please allow camera permissions.');
    }
  };

  // Close modal and stop camera
  const closeModal = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t: MediaStreamTrack) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setOpen(false);
  };

  // Take selfie
  const takeSelfie = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) {
      alert('Camera not ready. Please try again.');
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Mirror image
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/png');
    setPreview(dataUrl);
    setChoices(['😊', '🎉', '💃', '🕺']);
    closeModal();
  };

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-3">
        <div className="w-12 h-12 rounded-full bg-primary-100 grid place-items-center">
          <span className="text-xl">👤</span>
        </div>
        <div className="flex-1">
          <div className="text-sm text-gray-700">Scan your face to find your photos</div>
          <button className="btn btn-link text-primary-700 font-semibold p-0" onClick={openModal}>
            Scan your face
          </button>
        </div>
      </div>

      {/* Camera Modal */}
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center p-4 bg-black/40">
          <div className="card p-4 w-full max-w-sm bg-white">
            <div className="text-lg font-semibold mb-3 text-center">Smile at the camera!</div>

            <div className="relative mx-auto mb-4" style={{ width: 300, height: 300 }}>
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  borderRadius: 12,
                  overflow: 'hidden',
                  transform: 'scaleX(-1)',
                  background: '#000'
                }}
              >
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              </div>
            </div>

            <div className="flex justify-center gap-3">
              <button className="btn btn-secondary" onClick={closeModal}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={takeSelfie}>
                Capture
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Selfie Preview */}
      {preview && (
        <div className="flex justify-center">
          <img src={preview} alt="Your selfie" className="w-40 h-40 object-cover rounded-lg shadow-md" />
        </div>
      )}

      {/* Style Choices */}
      {choices.length > 0 && (
        <div className="space-y-3">
          <div className="text-sm text-gray-600">Pick a vibe:</div>
          <div className="flex gap-2 flex-wrap justify-center">
            {choices.map((c: string) => (
              <button
                key={c}
                className={`btn text-2xl p-3 ${selected === c ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => {
                  setSelected(c);
                  setRelated(relatedMap[c] || []);
                }}
              >
                {c}
              </button>
            ))}
          </div>

          {selected && (
            <div className="mt-3 text-center">
              <div className="text-sm text-gray-600 mb-2">Similar styles:</div>
              <div className="flex gap-2 flex-wrap justify-center">
                {related.map((r: string) => (
                  <span key={r} className="btn btn-outline text-xl px-3 py-2">
                    {r}
                  </span>
                ))}
                {related.length === 0 && <span className="text-sm text-gray-500">No similar styles</span>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}