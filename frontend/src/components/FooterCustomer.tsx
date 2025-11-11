export default function FooterCustomer({ tab, onTab }: { tab: 'album' | 'find'; onTab: (t: 'album' | 'find') => void }) {
  return (
    <div className="fixed bottom-0 inset-x-0 bg-white/90 dark:bg-gray-900/90 border-t border-gray-200 dark:border-gray-800 backdrop-blur p-2 flex justify-center gap-3">
      <button
        className={`btn ${tab === 'album' ? 'btn-primary' : 'btn-secondary'}`}
        onClick={() => onTab('album')}
      >
        Album
      </button>
      <button
        className={`btn ${tab === 'find' ? 'btn-primary' : 'btn-secondary'}`}
        onClick={() => onTab('find')}
      >
        Find Your Image
      </button>
    </div>
  );
}


