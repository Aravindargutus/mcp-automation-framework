'use client';

import { useSearchParams } from 'next/navigation';
import { useEffect, Suspense } from 'react';

function CallbackContent() {
  const params = useSearchParams();
  const success = params.get('success') === 'true';
  const error = params.get('error');
  const serverName = params.get('serverName');

  useEffect(() => {
    // Notify the opener window and close after a short delay
    if (window.opener) {
      window.opener.postMessage(
        { type: 'oauth-callback', success, error, serverName },
        window.location.origin,
      );
      setTimeout(() => window.close(), 2000);
    }
  }, [success, error, serverName]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="max-w-md rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
        {success ? (
          <>
            <div className="mb-3 text-4xl text-emerald-400">{'\u2713'}</div>
            <h1 className="text-xl font-bold text-zinc-100">Authorization Successful</h1>
            <p className="mt-2 text-sm text-zinc-400">
              Server <span className="font-medium text-zinc-200">{serverName}</span> is now authorized.
              This window will close automatically.
            </p>
          </>
        ) : (
          <>
            <div className="mb-3 text-4xl text-red-400">{'\u2717'}</div>
            <h1 className="text-xl font-bold text-zinc-100">Authorization Failed</h1>
            <p className="mt-2 text-sm text-red-400">{error}</p>
            <button
              onClick={() => window.close()}
              className="mt-4 rounded-lg bg-zinc-800 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-700"
            >
              Close
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function OAuthCallbackPage() {
  return (
    <Suspense fallback={<div className="flex min-h-[60vh] items-center justify-center text-zinc-500">Processing...</div>}>
      <CallbackContent />
    </Suspense>
  );
}
