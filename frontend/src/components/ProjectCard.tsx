import { useNavigate } from 'react-router-dom';
import type { Project } from '../types';

export default function ProjectCard({ project }: { project: Project }) {
  const nav = useNavigate();
  const shareUrl = `${location.origin}/project/${project.slug}`;
  return (
    <button
      onClick={() => nav(`/app/project/${project.slug}`)}
      className="text-left card overflow-hidden hover:shadow-md transition"
    >
      <div className="w-full h-36 bg-gray-100 dark:bg-gray-800 overflow-hidden">
        {project.coverUrl ? (
          <img src={project.coverUrl} alt={project.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full grid place-items-center text-gray-500">No cover</div>
        )}
      </div>
      <div className="p-3">
        <div className="font-medium truncate" title={project.name}>{project.name}</div>
        <div className="text-sm text-gray-500">Views: {project.views} · Impressions: {project.impressions}</div>
        <div className="mt-2 flex gap-2">
          <a
            className="btn btn-secondary text-sm"
            href={`mailto:?subject=${encodeURIComponent('Check out this album')}&body=${encodeURIComponent(shareUrl)}`}
            onClick={e => e.stopPropagation()}
          >
            Email
          </a>
          <a
            className="btn btn-primary text-sm"
            href={`https://wa.me/?text=${encodeURIComponent(shareUrl)}`}
            target="_blank"
            rel="noreferrer"
            onClick={e => e.stopPropagation()}
          >
            WhatsApp
          </a>
        </div>
      </div>
    </button>
  );
}


