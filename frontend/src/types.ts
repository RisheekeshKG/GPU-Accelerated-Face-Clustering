// ---------------- USER ----------------
export interface User {
  id: string;
  name?: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

// ---------------- ASSET ----------------
export interface Asset {
  id: string;
  name: string;
  url?: string; // uploaded or backend URL
  localUrl?: string; // blob URL for preview (frontend only)
  uploadedAt?: string;
  file?: File; // file reference before upload
}

// ---------------- SEARCH RESULT ----------------
export interface SearchResult {
  url: string;
  similarity: number;
  cluster: number;
}

// ---------------- EVENT ----------------
export interface EventItem {
  id: string;
  name: string;
  eventSlug?: string; // backend event folder slug
  coverUrl?: string; // uploaded or blob URL for event cover
  coverFile?: File; // file reference for event cover
  assets: Asset[];
  createdAt: string;
  searchResults?: SearchResult[]; // ✅ added safely
}

// ---------------- PROJECT ----------------
export interface Project {
  id: string;
  name: string;
  slug: string;
  ownerId: string;
  protected: boolean;
  passwordHash?: string;
  coverUrl?: string; // uploaded or blob URL for project cover
  coverFile?: File; // file reference for project cover
  events: EventItem[];
  views: number;
  impressions: number;
  createdAt: string;
}

// ---------------- APP STORE ----------------
export interface AppStore {
  users: User[];
  projects: Project[];
  sessions: { currentUserId?: string };
}
