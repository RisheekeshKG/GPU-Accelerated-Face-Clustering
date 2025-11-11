import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { Project } from "../types";
import { loadStore, saveStore } from "../utils/storage";
import PlusButton from "../components/PlusButton";

type SubmitStatus = "idle" | "loading" | "success" | "error";

const toBackendURL = (path?: string) => {
  if (!path) return "";
  const p = path.replace(/\\/g, "/");
  if (/^https?:\/\//i.test(p)) return p;
  if (p.startsWith("/uploads/")) return `http://127.0.0.1:8000${p}`;
  if (p.startsWith("uploads/")) return `http://127.0.0.1:8000/${p}`;
  return p;
};

const slugify = (name: string) => (name || "").replace(/[^A-Za-z0-9_-]+/g, "_");

const getProjectUserName = (proj: Project) => {
  const store = loadStore();
  const user = store.users.find((u) => u.id === store.sessions?.currentUserId);
  return user?.name || user?.email || proj.ownerId || proj.slug;
};

export default function ProjectEditor() {
  const { slug } = useParams();
  const nav = useNavigate();
  const store = loadStore();

  const projectIndex = store.projects.findIndex(
    (p: Project) => p.slug === slug
  );
  const [proj, setProj] = useState<Project | null>(
    projectIndex >= 0 ? store.projects[projectIndex] : null
  );

  const [submitStatus, setSubmitStatus] = useState<SubmitStatus>("idle");
  const [submitMessage, setSubmitMessage] = useState("");
  const [searchResults, setSearchResults] = useState<
    Record<string, Array<{ url: string; similarity: number; cluster: number }>>
  >({});
  const [eventSearching, setEventSearching] = useState<Record<string, boolean>>(
    {}
  );
  const [activeEventModal, setActiveEventModal] = useState<string | null>(null);

  // ✅ WebSocket progress tracking
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [clusters, setClusters] = useState<Record<string, number>>({});
  const [connectedEvents, setConnectedEvents] = useState<Set<string>>(
    new Set()
  );

  // Redirect if project not found
  useEffect(() => {
    if (!proj) nav("/app/dashboard", { replace: true });
  }, [proj, nav]);

  // Ensure structure consistency
  useEffect(() => {
    if (proj) {
      const fixed = structuredClone(proj);
      fixed.events = fixed.events.map((e) => ({
        ...e,
        searchResults: e.searchResults || [],
      }));
      setProj(fixed);
    }
  }, []);

  // Auto-save changes
  useEffect(() => {
    if (!proj) return;
    const s = loadStore();
    const i = s.projects.findIndex((p: Project) => p.id === proj.id);
    if (i >= 0) s.projects[i] = proj;
    saveStore(s);
  }, [proj]);

  if (!proj) return null;

  const setProject = (p: Project) => setProj({ ...p });
  const preview = useMemo(() => proj, [proj]);

  // ---------------------------------------------------------
  // EVENT MANAGEMENT
  // ---------------------------------------------------------
  const addEvent = () => {
    const name = prompt("Event name?")?.trim();
    if (!name) return;
    setProject({
      ...proj,
      events: [
        ...proj.events,
        {
          id: crypto.randomUUID(),
          name,
          createdAt: new Date().toISOString(),
          assets: [],
          coverFile: undefined,
          coverUrl: undefined,
          searchResults: [],
        },
      ],
    });
  };

  const handleCoverChange = async (file: File) => {
    const next = structuredClone(proj);
    next.coverFile = file;
    next.coverUrl = URL.createObjectURL(file);
    setProject(next);
  };

  const removeCover = () => {
    const next = structuredClone(proj);
    next.coverFile = undefined;
    next.coverUrl = undefined;
    setProject(next);
  };

  const handleEventCoverChange = async (eventId: string, file: File | null) => {
    if (!file) return;
    const next = structuredClone(proj);
    const ev = next.events.find((e) => e.id === eventId);
    if (!ev) return;
    ev.coverFile = file;
    ev.coverUrl = URL.createObjectURL(file);
    setProject(next);
  };

  const removeEventCover = (eventId: string) => {
    const next = structuredClone(proj);
    const ev = next.events.find((e) => e.id === eventId);
    if (!ev) return;
    ev.coverFile = undefined;
    ev.coverUrl = undefined;
    setProject(next);
  };

  const uploadAssets = async (eventId: string, files: FileList | null) => {
    if (!files?.length) return;
    const next = structuredClone(proj);
    const ev = next.events.find((e) => e.id === eventId);
    if (!ev) return;

    for (const file of Array.from(files)) {
      ev.assets.push({
        id: crypto.randomUUID(),
        name: file.name,
        file,
        localUrl: URL.createObjectURL(file),
        url: "",
        uploadedAt: new Date().toISOString(),
      });
    }
    setProject(next);
  };

  const removeAsset = (eventId: string, assetId: string) => {
    const next = structuredClone(proj);
    const ev = next.events.find((e) => e.id === eventId);
    if (!ev) return;
    ev.assets = ev.assets.filter((a) => a.id !== assetId);
    setProject(next);
  };

  const deleteEvent = (id: string) =>
    setProject({ ...proj, events: proj.events.filter((e) => e.id !== id) });

  const deleteProject = () => {
    if (!confirm("Delete project?")) return;
    const s = loadStore();
    s.projects = s.projects.filter((p: Project) => p.id !== proj.id);
    saveStore(s);
    nav("/app/dashboard", { replace: true });
  };

  // ---------------------------------------------------------
  // WEBSOCKET HANDLER
  // ---------------------------------------------------------
  const connectWebSocket = (eventId: string, eventName: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:8000/ws/progress/${eventId}`);
    setConnectedEvents((prev) => new Set([...prev, eventId]));
    setProgress((prev) => ({ ...prev, [eventId]: 0 }));

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "progress") {
          const pct = Math.round((data.current / data.total) * 100);
          setProgress((prev) => ({ ...prev, [eventId]: pct }));
          setSubmitMessage(`🔄 ${eventName}: Embedding faces (${pct}%)`);
        } else if (data.type === "done") {
          setProgress((prev) => ({ ...prev, [eventId]: 100 }));
          setClusters((prev) => ({ ...prev, [eventId]: data.clusters }));
          setSubmitMessage(`✅ ${eventName}: Done — ${data.clusters} clusters`);
          ws.close();
        }
      } catch (err) {
        console.error("[ws] message parse error:", err);
      }
    };

    ws.onclose = () => console.log(`[ws] closed for event ${eventId}`);
  };

  // ---------------------------------------------------------
  // UPLOAD PROJECT
  // ---------------------------------------------------------
  const handleSubmit = async () => {
    try {
      setSubmitStatus("loading");
      const project_user_name = getProjectUserName(proj);

      proj.events.forEach((ev) => {
        if (!connectedEvents.has(ev.id)) connectWebSocket(ev.id, ev.name);
      });

      const formData = new FormData();
      formData.append("project_user_name", project_user_name);

      formData.append(
        "project_data",
        JSON.stringify({
          name: proj.name,
          events: proj.events.map((e) => ({
            id: e.id, // ✅ frontend sends event ID to backend
            name: e.name,
            assets: e.assets.map((a) => ({ name: a.name })),
          })),
        })
      );

      if (proj.coverFile) formData.append("cover", proj.coverFile);
      proj.events.forEach((ev) => {
        if (ev.coverFile) formData.append("event_covers", ev.coverFile);
        ev.assets.forEach((a) => a.file && formData.append("photos", a.file));
      });

      const res = await fetch("http://127.0.0.1:8000/api/projects/", {
        method: "POST",
        body: formData,
      });

      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.error || "Upload failed");

      setSubmitStatus("success");
      setSubmitMessage("✅ Uploaded successfully — Processing started...");
    } catch (err: any) {
      setSubmitStatus("error");
      setSubmitMessage(err.message || "Upload failed");
    }
  };

  // ---------------------------------------------------------
  // SEARCH
  // ---------------------------------------------------------
  const handleEventSearch = (id: string) =>
    document.getElementById(`search-input-${id}`)?.click();

  const handleEventSearchFile = async (
    eventId: string,
    files: FileList | null
  ) => {
    try {
      if (!files || files.length === 0) {
        setSubmitMessage("⚠️ Please select a search image first.");
        return;
      }

      const file = files[0];
      const ext = (file.type && file.type.split("/")[1]) || "jpg";
      const renamedFile = new File(
        [file],
        `search_${slugify(file.name)}.${ext}`,
        { type: file.type || "image/jpeg" }
      );

      setEventSearching((s) => ({ ...s, [eventId]: true }));
      const ev = proj.events.find((e) => e.id === eventId);
      if (!ev) return;

      const project_user_name = getProjectUserName(proj);
      const eventSlug = ev.eventSlug || slugify(ev.name);

      const formData = new FormData();
      formData.append("photo", renamedFile);
      formData.append("project_user_name", project_user_name);
      formData.append("project_slug", proj.slug);
      formData.append("event_slug", eventSlug);

      const res = await fetch("http://127.0.0.1:8000/api/search-face/", {
        method: "POST",
        body: formData,
      });
      const payload = await res.json();

      const matches = payload?.results?.matches;
      if (Array.isArray(matches)) {
        const next = structuredClone(proj);
        const eventRef = next.events.find((e) => e.id === eventId);
        if (eventRef) {
          eventRef.searchResults = matches.map((m: any) => ({
            url: toBackendURL(m.photo),
            similarity: m.similarity,
            cluster: m.cluster ?? 0,
          }));
        }
        setProj(next);
        setSearchResults((prev) => ({
          ...prev,
          [eventId]:
            next.events.find((e) => e.id === eventId)?.searchResults || [],
        }));
        setActiveEventModal(eventId);
        setSubmitMessage(`✅ Found ${matches.length} matches.`);
      } else {
        setSubmitMessage(payload?.error || "⚠️ No matches found.");
      }
    } catch (err) {
      console.error("❌ Search upload failed:", err);
      setSubmitMessage("❌ Error uploading or processing search image.");
    } finally {
      setEventSearching((s) => ({ ...s, [eventId]: false }));
    }
  };

  // ---------------------------------------------------------
  // PROGRESS POPUP
  // ---------------------------------------------------------
  const ProgressPopup = () => {
    const hasProgress = Object.keys(progress).length > 0;
    if (!hasProgress) return null;

    const active = Object.entries(progress).filter(([_, pct]) => pct < 100);
    const done = Object.entries(progress).filter(([_, pct]) => pct >= 100);

    return (
      <div className="fixed bottom-6 right-6 z-50 bg-white/95 backdrop-blur-lg border shadow-lg rounded-lg p-4 w-80">
        <h4 className="font-semibold text-gray-800 mb-2">Processing Faces</h4>
        {active.length > 0 ? (
          <div className="space-y-3">
            {active.map(([id, pct]) => {
              const ev = proj.events.find((e) => e.id === id);
              return (
                <div key={id}>
                  <div className="flex justify-between text-sm font-medium mb-1">
                    <span>{ev?.name || "Unknown"}</span>
                    <span>{pct}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded h-3 overflow-hidden">
                    <div
                      className="bg-pink-500 h-3 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-green-600 text-sm">
            ✅ All events processed successfully.
          </div>
        )}
        {done.length > 0 && (
          <div className="mt-3 text-xs text-gray-500">
            Done:{" "}
            {done
              .map(([id]) => proj.events.find((e) => e.id === id)?.name)
              .join(", ")}
          </div>
        )}
      </div>
    );
  };

  // ---------------------------------------------------------
  // SEARCH MODAL
  // ---------------------------------------------------------
  const SearchModal = ({ eventId }: { eventId: string }) => {
    const list =
      searchResults[eventId] ??
      proj.events.find((e) => e.id === eventId)?.searchResults ??
      [];
    if (!list?.length) return null;

    return (
      <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
        <div className="bg-white p-5 rounded max-w-4xl w-full max-h-[80vh] overflow-auto">
          <div className="flex justify-between mb-3">
            <h3 className="font-semibold text-lg">Matches</h3>
            <button
              className="bg-gray-700 text-white px-3 py-1 rounded hover:bg-gray-800 transition"
              onClick={() => setActiveEventModal(null)}
            >
              Close
            </button>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {list.map((m, i) => (
              <div key={i} className="border rounded p-2 text-sm bg-gray-50">
                <img
                  src={m.url}
                  className="w-full h-32 object-cover rounded mb-2"
                  alt={`match-${i}`}
                />
                <div>Sim: {(m.similarity * 100).toFixed(1)}%</div>
                <div>Cluster: {m.cluster}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  // ---------------------------------------------------------
  // UI RENDER
  // ---------------------------------------------------------
  return (
    <div className="grid lg:grid-cols-2 gap-6 px-4">
      <div className="space-y-6">
        <input
          value={proj.name}
          onChange={(e) => setProject({ ...proj, name: e.target.value })}
          className="input text-xl font-semibold border rounded-lg px-4 py-2 w-full"
          placeholder="Project Name"
        />

        {/* PROJECT COVER */}
        <div className="card p-5 space-y-3 bg-white shadow-sm rounded-lg border">
          <h3 className="font-medium text-gray-800">Project Cover</h3>
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <label className="bg-pink-500 text-white px-4 py-2 rounded-md text-sm cursor-pointer hover:bg-pink-600 transition">
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) =>
                  e.target.files && handleCoverChange(e.target.files[0])
                }
              />
              Choose File
            </label>
            {proj.coverUrl && (
              <div className="relative w-40 h-24">
                <img
                  src={
                    proj.coverFile ? proj.coverUrl : toBackendURL(proj.coverUrl)
                  }
                  className="w-full h-full object-cover rounded border"
                  alt="project-cover"
                />
                <button
                  className="absolute top-1 right-1 text-white bg-black/60 px-1 text-xs rounded"
                  onClick={removeCover}
                >
                  ✕
                </button>
              </div>
            )}
          </div>
        </div>

        {/* ADD/DELETE */}
        <div className="flex justify-between items-center">
          <PlusButton label="Add Event" onClick={addEvent} />
          <button
            className="text-red-600 font-medium hover:underline"
            onClick={deleteProject}
          >
            Delete Project
          </button>
        </div>

        {/* EVENTS */}
        {proj.events.map((ev) => (
          <div
            key={ev.id}
            className="card p-5 rounded-lg shadow-sm bg-white border space-y-6"
          >
            <div className="flex justify-between items-center">
              <h4 className="font-semibold text-lg">{ev.name}</h4>
              <div className="flex gap-2 items-center">
                <button
                  onClick={() => handleEventSearch(ev.id)}
                  disabled={!!eventSearching[ev.id]}
                >
                  {eventSearching[ev.id] ? "Searching..." : "Search"}
                </button>
                {(searchResults[ev.id]?.length || ev.searchResults?.length) && (
                  <button
                    className="text-blue-600"
                    onClick={() => setActiveEventModal(ev.id)}
                  >
                    View
                  </button>
                )}
                <button
                  className="text-red-600"
                  onClick={() => deleteEvent(ev.id)}
                >
                  Delete
                </button>
                <input
                  id={`search-input-${ev.id}`}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => handleEventSearchFile(ev.id, e.target.files)}
                />
              </div>
            </div>

            {/* EVENT COVER */}
            <div className="space-y-3">
              <label className="font-medium text-sm text-gray-700">
                Event Cover
              </label>
              <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                <label className="bg-pink-500 text-white px-4 py-2 rounded-md text-sm cursor-pointer hover:bg-pink-600 transition">
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) =>
                      e.target.files &&
                      handleEventCoverChange(ev.id, e.target.files[0])
                    }
                  />
                  Choose File
                </label>
                {ev.coverUrl && (
                  <div className="relative w-24 h-16">
                    <img
                      src={
                        ev.coverFile ? ev.coverUrl : toBackendURL(ev.coverUrl)
                      }
                      className="w-full h-full object-cover rounded border"
                      alt="event-cover"
                    />
                    <button
                      className="absolute top-1 right-1 text-white bg-black/60 px-1 text-xs rounded"
                      onClick={() => removeEventCover(ev.id)}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* EVENT IMAGES */}
            <div className="space-y-3">
              <label className="font-medium text-sm text-gray-700">
                Event Images
              </label>
              <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                <label className="bg-pink-500 text-white px-4 py-2 rounded-md text-sm cursor-pointer hover:bg-pink-600 transition">
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    className="hidden"
                    onChange={(e) => uploadAssets(ev.id, e.target.files)}
                  />
                  Upload Images
                </label>
                <span className="text-xs text-gray-500">
                  {ev.assets.length
                    ? `${ev.assets.length} selected`
                    : "No files chosen"}
                </span>
              </div>

              {ev.assets.length > 0 && (
                <div className="grid grid-cols-3 md:grid-cols-4 gap-2 mt-2">
                  {ev.assets.map((a) => (
                    <div key={a.id} className="relative">
                      <img
                        src={a.localUrl || toBackendURL(a.url)}
                        className="w-full h-24 object-cover rounded border"
                        alt={a.name}
                      />
                      <button
                        className="absolute top-1 right-1 bg-black/60 text-white text-xs px-1 rounded"
                        onClick={() => removeAsset(ev.id, a.id)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* INLINE EVENT PROGRESS */}
            {progress[ev.id] !== undefined && (
              <div className="mt-3">
                <div className="w-full bg-gray-200 rounded h-4 overflow-hidden">
                  <div
                    className="bg-pink-500 h-4 text-xs text-center text-white transition-all"
                    style={{ width: `${progress[ev.id]}%` }}
                  >
                    {progress[ev.id]}%
                  </div>
                </div>
                {clusters[ev.id] !== undefined && (
                  <div className="text-sm text-green-600 mt-1">
                    ✅ {clusters[ev.id]} clusters generated
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {/* SUBMIT PROJECT */}
        <button
          className="bg-pink-500 text-white px-6 py-2 rounded-md hover:bg-pink-600 transition"
          onClick={handleSubmit}
        >
          {submitStatus === "loading" ? "Uploading..." : "Submit Project"}
        </button>
        {submitMessage && (
          <p className="text-sm mt-2 text-gray-700">{submitMessage}</p>
        )}
      </div>

      {/* RIGHT SIDE PREVIEW */}
      <div>
        <h3 className="font-semibold mb-3">Live Preview</h3>
        <div className="card overflow-hidden border rounded-lg bg-white shadow-sm">
          <div className="h-48 bg-gray-100">
            {proj.coverUrl ? (
              <img
                src={
                  proj.coverFile
                    ? proj.coverUrl
                    : toBackendURL(preview.coverUrl)
                }
                className="w-full h-full object-cover"
                alt="preview-cover"
              />
            ) : (
              <div className="grid place-items-center h-full text-gray-400 text-sm">
                No Cover
              </div>
            )}
          </div>

          <div className="p-3 text-xl font-semibold">{preview.name}</div>

          <div className="p-3 grid grid-cols-2 md:grid-cols-3 gap-2">
            {preview.events.map((e) => {
              const cover =
                e.coverUrl ||
                e.assets[0]?.localUrl ||
                toBackendURL(e.assets[0]?.url);
              return (
                <div
                  key={e.id}
                  className="card overflow-hidden border rounded-md"
                >
                  <div className="h-24 bg-gray-100">
                    {cover ? (
                      <img
                        src={cover}
                        className="w-full h-full object-cover"
                        alt={`${e.name}-cover`}
                      />
                    ) : (
                      <div className="grid place-items-center h-full text-gray-400 text-xs">
                        No cover
                      </div>
                    )}
                  </div>
                  <div className="p-2 text-sm">{e.name}</div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* MODALS + POPUPS */}
      {activeEventModal && <SearchModal eventId={activeEventModal} />}
      <ProgressPopup />
    </div>
  );
}
