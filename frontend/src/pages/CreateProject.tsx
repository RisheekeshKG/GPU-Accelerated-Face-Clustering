import { useState } from 'react';
import type { FormEvent } from 'react';
import { createProject, loadStore } from '../utils/storage';
import ProjectCard from '../components/ProjectCard';
import { useNavigate } from 'react-router-dom';

export default function CreateProject() {
  const [name, setName] = useState('');
  const [isProtected, setIsProtected] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const nav = useNavigate();
  const store = loadStore();
  const uid = store.sessions.currentUserId!;
  const userProjects = store.projects.filter(p => p.ownerId === uid);

  function onToggleProtected(checked: boolean) {
    setIsProtected(checked);
    if (checked && !password) {
      const pwd = prompt('Set a password for this project');
      if (pwd && pwd.trim()) {
        setPassword(pwd.trim());
      } else {
        setIsProtected(false);
      }
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const uid = loadStore().sessions.currentUserId!;
      const project = createProject(uid, name.trim(), isProtected, password);
      const shareUrl = `${location.origin}/project/${project.slug}`;
      // navigate to editor
      nav(`/app/project/${project.slug}`, { replace: true, state: { justCreated: true, shareUrl } });
    } catch (err: any) {
      setError(err.message || 'Failed to create project');
    }
  }

  return (
    <div className="space-y-6">
      <div className="section-header">
        <h1 className="text-xl font-semibold">Create Project</h1>
      </div>
      <form onSubmit={onSubmit} className="card p-4 space-y-3 max-w-2xl">
        <input
          className="input"
          placeholder="Project name"
          value={name}
          onChange={e => setName(e.target.value)}
          required
        />
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={isProtected} onChange={e => onToggleProtected(e.target.checked)} />
          <span>Enable protection</span>
        </label>
        {isProtected && (
          <input
            className="input"
            placeholder="Password"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
          />
        )}
        {error ? <div className="text-red-600 text-sm">{error}</div> : null}
        <button className="btn-primary">Create</button>
      </form>
      <div className="section">
        <div className="section-header">
          <h2 className="section-title">Your Projects</h2>
        </div>
        <div className="grid-cards">
          {userProjects.map(p => (
            <ProjectCard key={p.id} project={p} />
          ))}
          {userProjects.length === 0 && (
            <div className="text-gray-600">No projects yet. Create one to get started.</div>
          )}
        </div>
      </div>
    </div>
  );
}


