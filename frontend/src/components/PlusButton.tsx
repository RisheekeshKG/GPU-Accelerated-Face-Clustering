export default function PlusButton({ onClick, label }: { onClick?: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      className="btn btn-primary rounded-full"
    >
      <span className="text-lg">+</span>
      {label ? <span>{label}</span> : null}
    </button>
  );
}


