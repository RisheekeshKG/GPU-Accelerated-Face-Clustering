import { useState } from 'react';
import { loadStore, saveStore, hashPassword, comparePassword } from '../utils/storage';
import { useNavigate } from 'react-router-dom';

export default function Auth() {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const nav = useNavigate();

  function handleSignup() {
    setError('');
    const store = loadStore();
    const exists = store.users.some(u => u.email.toLowerCase() === email.toLowerCase());
    if (exists) {
      setError('Email already registered');
      return;
    }
    const user = {
      id: crypto.randomUUID(),
      name: name || undefined,
      email,
      passwordHash: hashPassword(password),
      createdAt: new Date().toISOString()
    };
    store.users.push(user);
    store.sessions.currentUserId = user.id;
    saveStore(store);
    nav('/app/dashboard', { replace: true });
  }

  function handleLogin() {
    setError('');
    const store = loadStore();
    const user = store.users.find(u => u.email.toLowerCase() === email.toLowerCase());
    if (!user) {
      setError('Invalid credentials');
      return;
    }
    if (!comparePassword(password, user.passwordHash)) {
      setError('Invalid credentials');
      return;
    }
    store.sessions.currentUserId = user.id;
    saveStore(store);
    nav('/app/dashboard', { replace: true });
  }

  return (
    <div className="min-h-screen grid place-items-center p-4">
      <div className="w-full max-w-md card p-6">
        <h1 className="text-2xl font-semibold mb-4">{mode === 'login' ? 'Login' : 'Sign up'}</h1>
        {mode === 'signup' && (
          <input
            className="input mb-3"
            placeholder="Name (optional)"
            value={name}
            onChange={e => setName(e.target.value)}
          />
        )}
        <input
          className="input mb-3"
          placeholder="Email"
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
        />
        <input
          className="input mb-3"
          placeholder="Password"
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
        />
        {error ? <div className="text-red-600 mb-3 text-sm">{error}</div> : null}
        <button
          className="w-full btn-primary mb-3"
          onClick={mode === 'login' ? handleLogin : handleSignup}
        >
          {mode === 'login' ? 'Login' : 'Create account'}
        </button>
        <div className="text-sm text-gray-600">
          {mode === 'login' ? (
            <button className="underline" onClick={() => setMode('signup')}>Create an account</button>
          ) : (
            <button className="underline" onClick={() => setMode('login')}>Already have an account? Login</button>
          )}
        </div>
      </div>
    </div>
  );
}


