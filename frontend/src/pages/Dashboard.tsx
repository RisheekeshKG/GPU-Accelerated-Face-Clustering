import { } from 'react';
import VideoHero from '../components/VideoHero';
import Card from '../components/Card';
import { } from '../utils/storage';
import { useNavigate } from 'react-router-dom';

export default function Dashboard() {
  // const store = loadStore();
  // const uid = store.sessions.currentUserId!;
  const nav = useNavigate();

  return (
    <div className="flex flex-col">
      <div className="w-full">
        <VideoHero videoId="dQw4w9WgXcQ" />
      </div>
      <div className="px-4 py-6 space-y-6">
        <div className="section-header">
          <h2 className="section-title">Quick Actions</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold">Plan Updation</div>
                <div className="text-sm text-gray-600">Current: Free</div>
              </div>
              <button className="btn-secondary">Upgrade</button>
            </div>
          </Card>
          <Card>
            <button
              className="w-full h-full flex items-center justify-center gap-2"
              onClick={() => nav('/app/create')}
            >
              <span className="text-xl">+</span>
              <span className="font-medium">Create</span>
            </button>
          </Card>
        </div>
        {/* Project list moved to Create page per request */}
      </div>
    </div>
  );
}


