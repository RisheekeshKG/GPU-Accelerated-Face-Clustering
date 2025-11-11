import { useState } from 'react';

export default function PasswordModal({ onSubmit, onClose }: { onSubmit: (password: string) => void; onClose: () => void }) {
  const [password, setPassword] = useState('');
  return (
    <div className="fixed inset-0 bg-black/50 grid place-items-center p-4">
      <div className="w-full max-w-sm card p-4">
        <h3 className="text-lg font-semibold mb-3">Enter Password</h3>
        <input
          type="password"
          className="input mb-3"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Password"
        />
        <div className="flex justify-end gap-2">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onSubmit(password)}>Unlock</button>
        </div>
      </div>
    </div>
  );
}


