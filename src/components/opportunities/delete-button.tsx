'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { deleteOpportunity } from '@/actions/opportunities';
import { Trash2, Loader2 } from 'lucide-react';

interface DeleteOpportunityButtonProps {
  id: string;
}

export function DeleteOpportunityButton({ id }: DeleteOpportunityButtonProps) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteOpportunity(id);
      router.push('/opportunities');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete opportunity');
      setIsDeleting(false);
      setShowConfirm(false);
    }
  };

  if (showConfirm) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-red-600 font-medium">Delete this opportunity?</span>
        <button
          type="button"
          onClick={handleDelete}
          disabled={isDeleting}
          className="inline-flex items-center gap-1 rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
        >
          {isDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Yes, Delete'}
        </button>
        <button
          type="button"
          onClick={() => setShowConfirm(false)}
          disabled={isDeleting}
          className="inline-flex items-center gap-1 rounded border px-3 py-1.5 text-xs font-medium hover:bg-accent transition-colors"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setShowConfirm(true)}
      className="inline-flex items-center gap-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 px-4 py-2 text-sm font-medium transition-colors"
    >
      <Trash2 className="h-4 w-4" />
      Delete
    </button>
  );
}