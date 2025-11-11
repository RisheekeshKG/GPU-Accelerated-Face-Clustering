import { useState } from 'react';

export default function FaceSearch() {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [results, setResults] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setPreview(f ? URL.createObjectURL(f) : null);
  }

  async function handleSearch() {
    if (!file) return;
    setLoading(true);
    setError(null);
    setResults(null);
    const fd = new FormData();
    fd.append('photo', file);
    fd.append('threshold', "0.7");

    try {
      const res = await fetch('http://localhost:8000/api/search-face/', {
        method: 'POST',
        body: fd,
      });
      if (!res.ok) throw new Error(await res.text());
      setResults(await res.json());
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-3xl mx-auto p-4">
      <h2 className="text-2xl font-semibold mb-4">Face Search</h2>
      <div className="card p-4 mb-4">
        <input type="file" accept="image/*" onChange={handleFileChange} />
        {preview && <img src={preview} className="w-48 h-48 object-cover mt-4" />}
        <button className="btn btn-primary mt-3" onClick={handleSearch} disabled={!file || loading}>
          {loading ? 'Searching...' : 'Search'}
        </button>
      </div>

      {error && <div className="text-red-600 mb-4">{error}</div>}

      {results && (
        <div className="card p-4">
          <h3 className="font-semibold mb-2">Results</h3>
          <div>Query saved at: <code>{results.query_path}</code></div>
          <div>Total matches: {results.result?.total_unique_photos ?? 0}</div>
        </div>
      )}
    </div>
  );
}
