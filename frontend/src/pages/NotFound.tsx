import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div className="min-h-screen grid place-items-center p-6">
      <div className="text-center">
        <div className="text-3xl font-semibold mb-2">404</div>
        <div className="mb-4">Page not found</div>
        <Link className="underline" to="/">Go home</Link>
      </div>
    </div>
  );
}


