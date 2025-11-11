import bcrypt from 'bcryptjs';
import type { AppStore, Project } from '../types';

export const APP_KEY = 'album_app_v1';

export function loadStore(): AppStore {
  const data = localStorage.getItem(APP_KEY);
  if (!data) return { users: [], projects: [], sessions: {} };
  try {
    return JSON.parse(data) as AppStore;
  } catch {
    return { users: [], projects: [], sessions: {} };
  }
}

export function saveStore(data: AppStore): void {
  localStorage.setItem(APP_KEY, JSON.stringify(data));
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function hashPassword(plain: string): string {
  const salt = bcrypt.genSaltSync(10);
  return bcrypt.hashSync(plain, salt);
}

export function comparePassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export function createProject(
  userId: string,
  name: string,
  isProtected: boolean,
  password?: string
): Project {
  const store = loadStore();
  const slug = slugify(name);
  const exists = store.projects.some(p => p.slug.toLowerCase() === slug.toLowerCase());
  if (exists) throw new Error('Project name already exists');

  const project: Project = {
    id: crypto.randomUUID(),
    name,
    slug,
    ownerId: userId,
    protected: isProtected,
    passwordHash: isProtected && password ? hashPassword(password) : undefined,
    coverUrl: '',
    views: 0,
    impressions: 0,
    events: [],
    createdAt: new Date().toISOString()
  };

  store.projects.push(project);
  saveStore(store);
  return project;
}

export function incrementView(projectId: string): void {
  const seenRaw = localStorage.getItem('seen_projects') || '[]';
  const seen: string[] = JSON.parse(seenRaw);
  if (!seen.includes(projectId)) {
    const store = loadStore();
    const proj = store.projects.find(p => p.id === projectId);
    if (proj) {
      proj.views += 1;
      saveStore(store);
    }
    seen.push(projectId);
    localStorage.setItem('seen_projects', JSON.stringify(seen));
  }
}

export function incrementImpression(projectId: string): void {
  const store = loadStore();
  const proj = store.projects.find(p => p.id === projectId);
  if (proj) {
    proj.impressions += 1;
    saveStore(store);
  }
}


